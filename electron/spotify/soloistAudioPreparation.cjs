const { randomUUID } = require('node:crypto');
const { boundedJson } = require('./catalogObservation.cjs');
const { REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE } = require('./grantScopes.cjs');
const { spotifyError } = require('./errors.cjs');
const { reportSpotifyHttp, reportSpotifyPreparationFailure } = require('./requestDiagnostics.cjs');

// electron/spotify/soloistAudioPreparation.cjs: official account control and private, memory-only PCM.
const same = (a, b) => a?.epoch === b?.epoch && a?.revision === b?.revision;
const validId = value => /^[A-Za-z0-9]{22}$/.test(value || '');
const cancelled = () => spotifyError('unavailable', 'request-cancelled');
function createSoloistAudioPreparation({ client, vault, cooldown, association, fetcher = fetch,
  media, now = Date.now, soloistApplyQuality }) {
  if (!client || !association || typeof association.acquirePlaybackTarget !== 'function') throw spotifyError('unavailable', 'soloist-unavailable');
  media ||= require('./soloistPcmProxy.cjs').createSoloistPcmProxy();
  let revision = 0, current, disposed = false;
  const jobs = new Map(), pending = new Set();
  function own(record) {
    if (disposed || current !== record || record.revision !== revision || record.controller.signal.aborted) throw cancelled();
    if (record.target && !same(record.target.stamp, vault.stamp())) throw spotifyError('auth-required', 'session-changed');
  }
  function track(task) { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); return task; }
  function readable(record, signal, stillConsumer = () => {}) {
    own(record);
    const readGeneration = (record.readGeneration || 0) + 1; record.readGeneration = readGeneration;
    return (async function* () {
      // The output may spend seconds opening HQPlayer before consuming PCM. Start the
      // bounded guest producer only when the ready output requests its first block.
      own(record); stillConsumer(); if (signal?.aborted) throw cancelled();
      const controller = new AbortController();
      const readSignal = AbortSignal.any([controller.signal, record.controller.signal, ...(signal ? [signal] : [])]);
      const source = client.openReadable(record.session, { signal: readSignal });
      let playbackFailure;
      const playing = client.play(record.session);
      void playing.catch(error => {
        playbackFailure = error; controller.abort();
        // Pause/seek cancels the old official observation while preserving this song's URL.
        if (error?.code === 'CANCELLED' || record.readGeneration !== readGeneration || current !== record) return;
        record.controller.abort(); record.handle?.revoke();
      });
      try {
        for await (const block of source) {
          if (playbackFailure) throw playbackFailure;
          own(record); stillConsumer(); yield block;
        }
        await playing; own(record); stillConsumer();
      } catch (error) { throw playbackFailure || error; }
    })();
  }
  async function release(record) {
    if (!record) return;
    if (record.releasing) return record.releasing;
    record.releasing = Promise.resolve().then(async () => {
      record.controller.abort(); record.handle?.revoke();
      if (!record.clientStarted) return;
      // The client's pre-mutation URI guard prevents pausing an externally selected track.
      await client.pause(record.session).catch(() => {});
      await client.close(record.session).catch(() => {});
    });
    return record.releasing;
  }
  async function api(record, method, route, body, endpoint) {
    own(record);
    if (now() < await cooldown.load()) throw spotifyError('unavailable', 'rate-limited');
    const token = await vault.token(); own(record);
    if (!token) throw spotifyError('auth-required');
    const response = await fetcher('https://api.spotify.com/v1/' + route, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(12000)]),
    }); own(record);
    reportSpotifyHttp(endpoint, method, response.status);
    if (response.status === 429) { await cooldown.defer(response.headers.get('retry-after')); throw spotifyError('unavailable', 'rate-limited'); }
    if (!response.ok) throw spotifyError(response.status === 401 ? 'auth-required' : response.status === 403 ? 'unsupported' : 'network', `playback-http-${response.status}`);
    if (method === 'PUT') {
      if (response.status !== 204) throw spotifyError('invalid-response', 'playback-response-unexpected');
      return null;
    }
    if (response.status === 204) return null;
    return boundedJson(response, () => own(record));
  }
  async function run(id, requestId, onProgress = () => {}, quality = 'high') {
    if (!validId(id) || !/^[a-f0-9-]{36}$/.test(requestId || '') || !['standard', 'high', 'lossless'].includes(quality))
      throw spotifyError('invalid-response', 'invalid-audio-request');
    if (disposed || jobs.has(requestId)) throw cancelled();
    const previous = current;
    const record = { revision: ++revision, session: randomUUID(), controller: new AbortController(), handle: null,
      prepared: false, target: null, requestId, trackId: id };
    current = record; jobs.set(requestId, record);
    let stage = 'scope';
    try {
      await release(previous); own(record); onProgress({ stage: 'connect' });
      if (now() < await cooldown.load()) throw spotifyError('unavailable', 'rate-limited');
      const scopes = await vault.grantedScopes(); own(record);
      if (!scopes.scopes?.includes(REQUIRED_DEVICE_SCOPE) || !scopes.scopes?.includes(REQUIRED_PLAYBACK_SCOPE))
        throw spotifyError('auth-required', 'playback-scope-required');
      if (soloistApplyQuality) {
        stage = 'quality-setup';
        const applied = await soloistApplyQuality(quality, { signal: record.controller.signal }); own(record);
        if (applied?.requestedQuality !== quality || applied.configurationApplied !== true || applied.sourceQuality !== null)
          throw spotifyError('invalid-response', 'soloist-quality-unconfirmed');
      }
      stage = 'track-metadata';
      const metadata = await api(record, 'GET', `tracks/${id}`, undefined, 'playback-track');
      const requestedUri = `spotify:track:${id}`;
      if (!metadata || metadata.type !== 'track' || !validId(metadata.id) || metadata.uri !== `spotify:track:${metadata.id}`
          || (metadata.id !== id && (metadata.linked_from?.id !== id || metadata.linked_from?.uri !== requestedUri || metadata.linked_from?.type !== 'track')))
        throw spotifyError('invalid-response', 'track-metadata-mismatch');
      const durationMs = metadata.duration_ms;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 3600000) throw spotifyError('invalid-response', 'invalid-duration');
      if (metadata.is_playable === false) throw spotifyError('not-playable', 'track-unavailable');
      stage = 'association';
      record.target = await association.acquirePlaybackTarget({ signal: record.controller.signal }); own(record);
      if (typeof record.target.deviceId !== 'string' || !record.target.deviceId || record.target.deviceId.length > 256
          || record.target.validUntil <= now()) throw spotifyError('unavailable', 'playback-association-expired');
      const uri = metadata.uri;
      // The device is a fresh main-owned candidate; official selection and SDK URI controls confirm it below.
      stage = 'playback-select';
      await api(record, 'PUT', `me/player/play?device_id=${encodeURIComponent(record.target.deviceId)}`, { uris: [uri], position_ms: 0 }, 'playback-select');
      // Web API player state can lag an acknowledged selection. Catalog metadata
      // supplies duration only; prepare proves the fresh owned SDK URI and active
      // authorization before its guarded pause/seek and PCM lease are published.
      record.clientStarted = true;
      stage = 'pcm-prepare';
      const prepared = await client.prepare({ session: record.session, trackId: metadata.id, positionMs: 0, durationMs, requestedQuality: quality,
        selectionPending: true });
      record.prepared = true; record.durationMs = durationMs; record.originMs = prepared.positionMs; own(record);
      stage = 'publish';
      record.handle = await media.add({
        open: ({ signal }) => {
          // Read continuously while the official post-play observation settles. No unbounded prebuffer.
          record.opened = true;
          return readable(record, signal);
        },
        close: () => release(record),
      }); own(record);
      onProgress({ stage: 'validate' });
      // A prepared PCM32 stream says nothing about the encrypted source codec or lossless tier.
      return { url: record.handle.url, fetchedAt: now(), requestedQuality: quality, quality: null, actualQuality: null,
        streaming: true, sessionBoundAudio: true, playbackTransport: 'soloist-pcm', durationMs,
        sourceInfo: { codec: null, container: null, encodingVerified: false, sampleRate: null, channels: null,
          bitDepth: null, bitrate: null, bitrateKind: null, lossless: null },
        preparedAudio: { codec: 'PCM', representation: 's32le', sampleFormat: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 },
        pcmOriginMs: prepared.positionMs };
    } catch (error) {
      const wasCancelled = record.controller.signal.aborted || current !== record || record.revision !== revision;
      await release(record);
      if (current === record) current = null;
      // Catalog authorization and receiver setup are independent. Preserve the
      // actionable missing-setup result without exposing a key or raw exception.
      const failure = wasCancelled ? cancelled()
        : error?.code === 'SOLOIST_KEY_REQUIRED' ? spotifyError('setup-required', 'playback-setup-required')
        : error?.message?.startsWith('Spotify: ') ? error
        : spotifyError(error?.code === 'AUTH_REQUIRED' ? 'auth-required' : 'unavailable',
          error?.code === 'TRACK_NOT_CURRENT' ? 'external-playback-change' : 'soloist-preparation-failed');
      reportSpotifyPreparationFailure(requestId, stage, error, failure);
      throw failure;
    } finally { if (jobs.get(requestId) === record) jobs.delete(requestId); }
  }
  return { prepare(...args) { return track(run(...args)); },
    // Main-only resolver: native engines consume PCM directly instead of caching decoded bytes.
    lookup(url) {
      const record = current;
      if (!record || record.handle?.url !== url || record.releasing || record.controller.signal.aborted) return null;
      // Output disposal is asynchronous. A retiring output must never pause the new
      // consumer which has already resumed this same song and opaque source URL.
      const consumer = Symbol('soloist-output-consumer'); let claimed = false;
      const consumerSerial = (record.consumerSerial || 0) + 1; record.consumerSerial = consumerSerial;
      const assertConsumer = () => { own(record); if (record.outputOwner !== consumer) throw cancelled(); };
      const claim = () => {
        own(record); if ((claimed && record.outputOwner !== consumer) || (record.outputSerial || 0) > consumerSerial) throw cancelled();
        record.outputOwner = consumer; record.outputSerial = consumerSerial; claimed = true;
      };
      const park = async () => {
        own(record);
        if ((claimed && record.outputOwner !== consumer) || (record.outputSerial || 0) > consumerSerial) return;
        claim(); record.opened = true; await client.pause(record.session);
      };
      return { trackId: record.trackId, durationMs: record.durationMs, sampleRate: 44100, channels: 2, bitDepth: 32,
        async seek(positionMs) {
          if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs >= record.durationMs) throw spotifyError('invalid-response', 'invalid-position');
          claim();
          const positioned = await client.seek(record.session, positionMs); assertConsumer();
          record.originMs = positioned.positionMs; record.opened = false;
          return { positionMs: positioned.positionMs };
        },
        async openReadable({ positionMs = 0, signal } = {}) {
          if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs >= record.durationMs) throw spotifyError('invalid-response', 'invalid-position');
          claim();
          if (record.opened || positionMs !== record.originMs) {
            const positioned = await client.seek(record.session, positionMs); assertConsumer(); record.originMs = positioned.positionMs;
          }
          record.opened = true;
          return { stream: readable(record, signal, assertConsumer), positionMs: record.originMs };
        },
        pause: park,
        stop: park,
        revoke() { return release(record); },
      };
    },
    cancel(requestId) { const record = jobs.get(requestId) || (current?.requestId === requestId ? current : null); if (record) void track(release(record)); },
    async clear() { ++revision; const previous = current; current = null; for (const job of jobs.values()) job.controller.abort(); await release(previous); await Promise.allSettled([...pending]); },
    async close() { disposed = true; await this.clear(); await media.close(); },
  };
}
module.exports = { createSoloistAudioPreparation };
