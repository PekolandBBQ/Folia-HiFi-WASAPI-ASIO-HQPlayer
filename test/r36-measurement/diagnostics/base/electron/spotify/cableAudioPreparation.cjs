'use strict';
const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');
const { randomUUID } = require('node:crypto');
const { boundedJson } = require('./catalogObservation.cjs');
const { REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE } = require('./grantScopes.cjs');
const { reportSpotifyHttp, reportSpotifyPreparationFailure } = require('./requestDiagnostics.cjs');
const { RATE, FRAME_BYTES, QUEUE_BYTES, BOOTSTRAP_QUEUE_BYTES, sessionId, selectionFields, processBinding, requireConfiguration } = require('./cableCaptureProtocol.cjs');
const { fail, validTrack, position, sameStamp, metadataFacts, requireFacts, publicError, diagnosticCode } = require('./cableAudioFacts.cjs');
const { LIVE_PCM_TRANSPORT } = require('../nativeAudio/livePcmFormat.cjs');
const { createOwnedRouteAudio } = require('./ownedRouteAudio.cjs');
const { admitted } = require('./ownedRouteTrial.cjs');

// electron/spotify/cableAudioPreparation.cjs: official desktop control bound to a revocable, memory-only CABLE source.
function createCableAudioPreparation({ captureHost, control, vault, cooldown, getSelection, prefetchSelection, routeLifecycle, fetcher = fetch,
  media, officialMetadata, now = Date.now, pollMs = 2000, cleanupTimeoutMs = 6000, onDiagnostic = () => {} } = {}) {
  if (!captureHost || !['inspectRoute', 'open'].every(key => typeof captureHost[key] === 'function')
    || !control || !['prepare', 'readState', 'play', 'pause', 'seek', 'close'].every(key => typeof control[key] === 'function')
    || !vault || !['token', 'stamp', 'grantedScopes'].every(key => typeof vault[key] === 'function')
    || !cooldown || !['load', 'defer'].every(key => typeof cooldown[key] === 'function')
    || officialMetadata != null && !['bind', 'get', 'remember', 'remove'].every(key => typeof officialMetadata[key] === 'function')
    || typeof getSelection !== 'function' || prefetchSelection != null && typeof prefetchSelection !== 'function' || typeof fetcher !== 'function' || typeof onDiagnostic !== 'function' || pollMs !== 2000
    || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 10000)
    throw publicError(fail('PROTOCOL_INVALID'));
  media ||= require('./soloistPcmProxy.cjs').createSoloistPcmProxy();
  const ownedAudio = routeLifecycle && createOwnedRouteAudio({ routeLifecycle, captureHost });
  let current, revision = 0, disposed = false;
  const jobs = new Map(), pending = new Set(), cleanupRecords = new Set();
  const metadataCache = new Map();
  let metadataStamp;
  function forgetMetadata(record, error) {
    // Normal reader cancellation preserves catalog facts; explicit cancel/revoke/clear still evict them.
    if (['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(error?.code)) return;
    if (officialMetadata) { if (record.metadataEntry) officialMetadata.remove(record.trackId, record.metadataEntry); return; }
    if (record.metadataEntry && metadataCache.get(record.trackId) === record.metadataEntry) metadataCache.delete(record.trackId);
  }
  function reportFailure(record, error) {
    // Control preparation can revoke this source before native capture is requested.
    // Its preparation/control diagnostics must not imply an attempted capture.
    if (record.read?.captureRequested !== true) return;
    if (record.failureReported) return;
    record.failureReported = true;
    try { onDiagnostic({ phase: 'failed', session: record.session, generation: record.read?.capture?.generation,
      errorCode: diagnosticCode(error) }); } catch { /* Diagnostics never change session cleanup. */ }
  }
  function track(task) { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); return task; }
  function own(record) {
    if (disposed || current !== record || record.revision !== revision) throw fail('CANCELLED');
    // A current source failure outlives the retired reader and remains visible to its replacement.
    if (record.failure && !['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) throw record.failure;
    if (record.releasing || record.controller.signal.aborted) throw fail('CANCELLED');
    if (record.stamp && !sameStamp(record.stamp, vault.stamp())) throw fail('SESSION_CHANGED');
  }
  function readOwned(record, read) {
    own(record);
    if (record.read !== read || record.intent !== read.intent || record.outputOwner !== read.owner || read.controller.signal.aborted)
      throw read.failure || fail('CANCELLED');
  }
  async function boundedCleanup(task) {
    let timer;
    try { await Promise.race([Promise.resolve(task).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  function invalidateRead(record) {
    const read = record.read; record.read = null;
    if (!read) return;
    if (record.automaticRouting) record.retiredReads.add(read);
    read.routeAudio?.publicationStopped();
    clearTimeout(read.poll); read.detach?.(); read.controller.abort();
    if (read.capture) void Promise.resolve(read.capture.stop()).catch(() => {});
  }
  function confirmRoutePaused(record) {
    record.preparationRoute?.confirmPaused();
    record.heldRoute?.confirmPaused();
    record.read?.routeAudio?.confirmPaused();
    for (const read of record.retiredReads) read.routeAudio?.confirmPaused();
  }
  function routedPreparation(record) {
    return {
      beforeSelect: async paused => {
        own(record);
        if (record.preparationRoute || paused.isPlaying !== false || paused.deviceId !== record.selection.deviceId)
          throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.preparationRoute = ownedAudio.create({ session: record.session, selection: record.selection,
          binding: record.routeBinding, pausedTrackId: paused.trackId, selectedTrackId: record.resolvedTrackId,
          signal: record.controller.signal,
          onFailure: error => { void revokeSession(record.session, error.code).catch(() => {}); } });
        await record.preparationRoute.prepareSelection(); own(record);
      },
      afterPark: async () => { own(record); await record.preparationRoute.completePreparation(); own(record); },
    };
  }
  async function restorePreparation(record) {
    const prepared = record.preparationRoute;
    if (!prepared) return;
    await prepared.close();
    if (record.preparationRoute === prepared) record.preparationRoute = null;
  }
  async function restoreRetired(record) {
    for (const read of record.retiredReads || []) {
      await read.routeAudio?.close(); record.retiredReads.delete(read);
    }
  }
  async function restoreHeld(record) {
    const held = record.heldRoute;
    if (!held) return;
    await held.close();
    if (record.heldRoute === held) record.heldRoute = null;
  }
  async function holdRoutes(record) {
    const routes = new Set([record.heldRoute, record.preparationRoute,
      ...[...record.retiredReads].map(read => read.routeAudio)].filter(Boolean));
    if (routes.size > 1) throw fail('ROUTE_PROOF_UNCONFIRMED');
    for (const route of routes) {
      await route.suspendPaused();
      record.heldRoute = route;
    }
    record.preparationRoute = null;
    record.retiredReads.clear();
  }
  function release(record) {
    if (!record) return Promise.resolve();
    if (record.releasing && record.cleanupFailure) {
      const routes = [record.preparationRoute, record.heldRoute, ...[...record.retiredReads || []].map(read => read.routeAudio)].filter(Boolean);
      // A later lifecycle shutdown may prove the exact terminal lease. Re-run
      // local disposal only when all retained route owners report that proof.
      if (routes.length && routes.every(route => route.restored === true)) record.releasing = null;
    }
    if (record.releasing) return record.releasing;
    cleanupRecords.add(record);
    // Keep the official lease alive just long enough for a guarded pause. Its close
    // is session-scoped, so late cleanup cannot affect a subsequent selected track.
    record.releasing = Promise.resolve().then(async () => {
      if (record.automaticRouting) {
        await record.preparationPromise?.catch(() => {});
        await record.queue.catch(() => {});
      }
      if (record.prepared) {
        if (record.automaticRouting) {
          try { const paused = await control.pause(record.session); requireFacts(paused, record, false); confirmRoutePaused(record); }
          catch { /* Unconfirmed quiescence remains blocked by the owned lease; it must never be restored as clean. */ }
        } else await boundedCleanup(Promise.resolve().then(() => control.pause(record.session)));
      }
      try {
        await restoreRetired(record);
        await record.preparationRoute?.close();
        await restoreHeld(record);
      } finally {
        await boundedCleanup(Promise.resolve().then(() => control.close(record.session)));
        record.controlController.abort();
      }
    });
    record.intent++; record.controller.abort(); invalidateRead(record);
    if (!record.prepared && !record.automaticRouting) record.controlController.abort();
    if (record.handle) void Promise.resolve(record.handle.revoke()).catch(() => {});
    void record.releasing.then(() => cleanupRecords.delete(record), error => {
      record.cleanupFailure = error;
      if (isRetryableRouteCleanup(error)) record.releasing = null;
    });
    return record.releasing;
  }
  function revokeSession(session, code = 'CANCELLED') {
    const record = current;
    if (!record || record.session !== session) return Promise.resolve();
    forgetMetadata(record);
    if (!record.failure || ['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) record.failure = fail(code);
    if (!['CANCELLED', 'SUPERSEDED', 'CLOSED'].includes(code)) reportFailure(record, record.failure);
    if (record.read) record.read.failure = record.failure;
    return track(release(record));
  }
  function enqueue(record, guard, action) {
    const task = record.queue.catch(() => {}).then(async () => { own(record); guard(); return action(); });
    record.queue = task; return task;
  }
  function operationError(record, error) {
    forgetMetadata(record, error);
    if (!['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(error?.code) && current === record && !record.releasing)
      {
        if (!record.failure || ['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) record.failure = error;
        reportFailure(record, record.failure); void track(release(record));
      }
    return publicError(error);
  }
  async function metadata(record, speculative = false) {
    if (now() < await cooldown.load()) throw fail('RATE_LIMITED');
    own(record);
    const token = speculative ? await vault.token({ allowRefresh: false }) : await vault.token(); own(record);
    if (!token) throw fail(speculative ? 'PREPARATION_READ_DEFERRED' : 'AUTH_REQUIRED');
    record.stamp = { ...vault.stamp() };
    const receipt = officialMetadata?.bind();
    if (!officialMetadata) {
      if (!sameStamp(metadataStamp, record.stamp)) { metadataCache.clear(); metadataStamp = { ...record.stamp }; }
      const at = now();
      for (const [key, entry] of metadataCache) if (at < entry.observedAt || at - entry.observedAt >= 60000) metadataCache.delete(key);
    }
    const cached = officialMetadata ? officialMetadata.get(record.trackId, receipt) : metadataCache.get(record.trackId);
    if (cached) {
      own(record);
      if (speculative) return { facts: cached.facts, cached, receipt, observedAt: cached.observedAt };
      record.metadataEntry = cached; return cached.facts;
    }
    const response = await fetcher(`https://api.spotify.com/v1/tracks/${record.trackId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(12000)]),
    }); own(record); reportSpotifyHttp('playback-track', 'GET', response.status);
    if (response.status === 429) { await cooldown.defer(response.headers.get('retry-after')); throw fail('RATE_LIMITED'); }
    if (response.status !== 200) throw fail(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'API_FORBIDDEN' : 'API_UNAVAILABLE');
    const raw = await boundedJson(response, () => own(record));
    const facts = Object.freeze(metadataFacts(raw, record.trackId));
    own(record);
    if (speculative) return { facts, raw, receipt, observedAt: now() };
    if (officialMetadata) {
      record.metadataEntry = officialMetadata.remember(raw, record.trackId, receipt);
      // Partial catalog objects can satisfy this request's historical validation,
      // but cannot create a private fallback that bypasses the shared eligibility gate.
      return facts;
    }
    // Cache only validated catalog identity/duration, under the original account and fixed one-minute lifetime.
    const entry = { facts, observedAt: now() };
    if (metadataCache.size >= 32) metadataCache.delete(metadataCache.keys().next().value);
    metadataCache.set(record.trackId, entry); record.metadataEntry = entry;
    return facts;
  }
  // Only the post-restoration owner may publish speculative catalog facts.
  async function acceptMetadata(record, snapshot) {
    own(record);
    if (officialMetadata && !officialMetadata.isCurrent(snapshot.receipt)) throw fail('SESSION_CHANGED');
    if (snapshot.observedAt > now() || now() - snapshot.observedAt >= 60000) return metadata(record);
    if (snapshot.cached) {
      if (officialMetadata && officialMetadata.get(record.trackId, snapshot.receipt) !== snapshot.cached) return metadata(record);
      record.metadataEntry = snapshot.cached;
    } else if (officialMetadata) record.metadataEntry = officialMetadata.remember(snapshot.raw, record.trackId, snapshot.receipt,
      { observedAt: snapshot.observedAt });
    else {
      const entry = { facts: snapshot.facts, observedAt: snapshot.observedAt };
      if (metadataCache.size >= 32) metadataCache.delete(metadataCache.keys().next().value);
      metadataCache.set(record.trackId, entry); record.metadataEntry = entry;
    }
    return snapshot.facts;
  }
  // Attach both rejection observers immediately: cleanup can fail, or a newer
  // intent can cancel this request, before either read has produced a response.
  function beginPreparationReads(record) {
    const observe = (action, stage) => Promise.resolve().then(action)
      .then(value => ({ value, stage }), error => { throw { error, stage }; });
    const reads = observe(async () => {
      const scopes = await vault.grantedScopes(); own(record);
      if (!scopes.scopes?.includes(REQUIRED_DEVICE_SCOPE) || !scopes.scopes?.includes(REQUIRED_PLAYBACK_SCOPE)) throw fail('SCOPE_REQUIRED');
    }, 'scope').then(() => Promise.all([
      observe(() => metadata(record, true), 'track-metadata'),
      observe(() => prefetchSelection({ signal: record.controller.signal, session: record.session }), 'association'),
    ])).then(value => ({ value }), failure => failure);
    const signal = record.controller.signal;
    let abort;
    const cancelled = new Promise(resolve => {
      abort = () => resolve({ error: fail('CANCELLED'), stage: 'scope' });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    // A cancelled transport may still produce a late response. It remains
    // observed above, but cannot hold this source request or publish its facts.
    return Promise.race([reads, cancelled]).finally(() => signal.removeEventListener('abort', abort));
  }
  function schedulePoll(record, read) {
    read.poll = setTimeout(async () => {
      try {
        readOwned(record, read);
        const facts = await control.readState(record.session); readOwned(record, read); requireFacts(facts, record, true);
        if (read.capture.status) { await read.capture.status(); readOwned(record, read); }
        if (read.routeAudio) { await read.routeAudio.verifyActive(); readOwned(record, read); }
        schedulePoll(record, read);
      } catch (error) {
        if (record.read === read && !read.controller.signal.aborted) {
          read.failure = error; void revokeSession(record.session, error?.code || 'PLAYBACK_STATE_UNCONFIRMED');
        }
      }
    }, pollMs);
    read.poll.unref?.();
  }
  function readable(record, read) {
    return (async function* () {
      let complete = false;
      try {
        readOwned(record, read);
        await enqueue(record, () => readOwned(record, read), async () => {
          // Output creation can take seconds. Recheck the parked official identity
          // before opening capture; no native queue is started during that wait.
          let parked = await control.readState(record.session, { forPreparation: true }); readOwned(record, read); requireFacts(parked, record, false);
          if (parked.positionMs !== read.positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
          const onFailure = error => {
            if (record.read !== read) return;
            read.failure = error; void revokeSession(record.session, error?.code || 'CAPTURE_REQUEST_FAILED').catch(() => {});
          };
          if (record.automaticRouting) {
            if (!record.preparationRoute) throw fail('ROUTE_PROOF_UNCONFIRMED');
            read.routeAudio = record.preparationRoute; record.preparationRoute = null;
            read.captureRequested = true;
            await read.routeAudio.start({ signal: read.controller.signal, onFailure });
          } else read.captureRequested = true;
          const capture = read.routeAudio?.capture || await captureHost.open({ session: record.session, ...record.selection,
            signal: read.controller.signal, onFailure });
          read.capture = capture;
          try { readOwned(record, read); } catch (error) { void Promise.resolve(capture.stop()).catch(() => {}); throw error; }
          if (!read.routeAudio) await capture.start(); readOwned(record, read);
          const playing = await control.play(record.session); readOwned(record, read); requireFacts(playing, record, true);
          let bufferedPrefix = 0;
          if (read.routeAudio) {
            await read.routeAudio.verifyActive(); readOwned(record, read);
            const promoted = await read.routeAudio.promote(); readOwned(record, read); bufferedPrefix = promoted.capturedFrames;
            // Native promotion opens only the private pipe. Recheck the retained isolation interval before
            // publishing its preserved prefix, including any event observed during proof-to-promotion.
            await read.routeAudio.verifyActive(); readOwned(record, read);
            if (typeof capture.beginPublication !== 'function') throw fail('CAPTURE_PROTOCOL_INVALID');
            bufferedPrefix = Math.max(bufferedPrefix, capture.beginPublication()); readOwned(record, read);
          }
          const prefixFrames = Math.max(capture.receivedFrames(), bufferedPrefix);
          if (!Number.isSafeInteger(prefixFrames) || prefixFrames < 0 || prefixFrames * FRAME_BYTES > (read.routeAudio ? BOOTSTRAP_QUEUE_BYTES : QUEUE_BYTES))
            throw fail('CAPTURE_PROTOCOL_INVALID');
          // Capture can start before Spotify emits this song. Keep that bounded
          // lead outside the remaining-song budget instead of truncating the tail.
          // The official position is an approximate observation, not sample timing.
          read.maximumBytes = (prefixFrames + Math.max(1, Math.ceil((record.durationMs - playing.positionMs) * RATE / 1000))) * FRAME_BYTES;
          // The host drains continuously into a bounded ring while this official
          // observation settles. Nothing is published before it confirms playing.
          schedulePoll(record, read);
        });
        const maximum = read.maximumBytes;
        read.routeAudio?.publicationStarted();
        let delivered = 0;
        for await (const block of read.capture.stream) {
          readOwned(record, read);
          if (!Buffer.isBuffer(block) || !block.length || block.length > 65536 || block.length % FRAME_BYTES) throw fail('CAPTURE_FRAME_INVALID');
          const accepted = Math.min(block.length, maximum - delivered);
          delivered += accepted;
          yield accepted === block.length ? block : Buffer.from(block.subarray(0, accepted));
          if (delivered === maximum) { readOwned(record, read); complete = true; break; }
        }
        if (!complete) throw fail('CAPTURE_PIPE_CLOSED');
      } catch (error) {
        const cause = read.failure || error;
        throw operationError(record, cause);
      } finally {
        if (record.read === read) {
          invalidateRead(record);
          const intent = record.intent, owner = read.owner;
          // A completed or disconnected old consumer cannot pause a replacement.
          const guard = () => { if (record.intent !== intent || record.outputOwner !== owner) throw fail('CANCELLED'); };
          const cleanup = enqueue(record, guard, async () => {
            const paused = await control.pause(record.session); guard(); requireFacts(paused, record, false); confirmRoutePaused(record);
            if (complete) { await restoreRetired(record); await restorePreparation(record); await restoreHeld(record); }
            else await holdRoutes(record);
            return paused;
          }).catch(error => {
            const mapped = current === record && record.intent === intent && !record.releasing
              ? operationError(record, error) : publicError(error);
            if (complete) throw mapped;
          });
          // Natural EOF authorizes the next track. Expose it only after the source
          // is parked, capture is stopped, and the exact original route is restored.
          if (complete) await cleanup;
        }
      }
    })();
  }
  function lookup(url) {
    const record = current;
    if (!record || record.handle?.url !== url || record.releasing || record.controller.signal.aborted) return null;
    const consumer = Symbol('cable-output-consumer'), serial = ++record.consumerSerial;
    let claimed = false, latestReader;
    function claim() {
      own(record);
      if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) throw fail('CANCELLED');
      record.outputOwner = consumer; record.outputSerial = serial; claimed = true;
    }
    function begin(signal) {
      if (signal?.aborted) throw fail('CANCELLED');
      claim(); const intent = ++record.intent; invalidateRead(record);
      const guard = () => {
        own(record);
        if (record.intent !== intent || record.outputOwner !== consumer || signal?.aborted) throw fail('CANCELLED');
      };
      return { intent, guard };
    }
    async function park({ positionMs, releaseRoute = false } = {}) {
      if (positionMs != null && !position(positionMs, record.durationMs)) throw publicError(fail('INVALID_POSITION'));
      try {
        own(record);
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return;
        const { guard } = begin(); record.opened = true;
        return await enqueue(record, guard, async () => {
          const paused = await control.pause(record.session); guard(); requireFacts(paused, record, false);
          confirmRoutePaused(record);
          if (releaseRoute) { await restoreRetired(record); await restorePreparation(record); await restoreHeld(record); }
          else await holdRoutes(record);
          guard();
          // The official producer can be seconds ahead of the speaker. Only the
          // output's heard checkpoint may advance the origin stored across Pause.
          if (positionMs != null) record.originMs = positionMs;
          return { positionMs: record.originMs };
        });
      } catch (error) { throw operationError(record, error); }
    }
    return {
      trackId: record.trackId, durationMs: record.durationMs, sampleRate: RATE, channels: 2, bitDepth: 32,
      assertReader(reader) {
        if (!reader || reader !== latestReader) throw fail('CANCELLED');
        reader.assertCurrent();
      },
      async seek(positionMs) {
        if (!position(positionMs, record.durationMs)) throw publicError(fail('INVALID_POSITION'));
        // A paused seek only updates the requested checkpoint. Positioning the
        // actual source belongs to the next fresh capture preparation.
        return park({ positionMs });
      },
      async openReadable({ positionMs = 0, signal } = {}) {
        if (!position(positionMs, record.durationMs)) throw publicError(fail('INVALID_POSITION'));
        try {
          const { intent, guard } = begin(signal);
          return await enqueue(record, guard, async () => {
            let parked;
            if (!record.automaticRouting || record.retiredReads.size || record.preparationRoute) {
              parked = await control.pause(record.session, { forPreparation: true }); guard(); requireFacts(parked, record, false);
              confirmRoutePaused(record);
              // Replacing an active output keeps its exact same-track route, but
              // retires capture and its format holder before creating a new one.
              if (record.retiredReads.size) { await holdRoutes(record); guard(); }
            }
            if (record.automaticRouting && record.heldRoute) {
              if (typeof control.resumeOwnedRoute !== 'function') throw fail('ROUTE_PROOF_UNCONFIRMED');
              const held = record.heldRoute;
              // Move ownership before the awaited resume so failure cleanup still
              // finds the lease even when native accepted only part of the command.
              record.preparationRoute = held; record.heldRoute = null;
              // A replaced reader cannot interrupt an already-owned source transaction.
              // Keep account, source, consumer and route ownership strict while its PUT
              // and native preparation settle; only PCM publication follows reader intent.
              const resumeOwned = () => {
                own(record);
                if (record.outputOwner !== consumer || record.preparationRoute !== held) throw fail('CANCELLED');
              };
              parked = await control.resumeOwnedRoute(record.session, { positionMs,
                beforePosition: async () => { resumeOwned(); await held.resumePreparation(); resumeOwned(); },
                afterPark: async () => { resumeOwned(); await held.completePreparation(); resumeOwned(); },
              });
              resumeOwned(); requireFacts(parked, record, false);
              if (parked.positionMs !== positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
              if (record.intent !== intent || signal?.aborted) {
                confirmRoutePaused(record);
                await holdRoutes(record);
                throw fail('CANCELLED');
              }
              guard();
            } else if (record.automaticRouting && !record.preparationRoute) {
              if (typeof control.prepareOwnedRoute !== 'function') throw fail('ROUTE_PROOF_UNCONFIRMED');
              await record.refreshRouteBinding(); guard();
              parked = await control.prepareOwnedRoute(record.session, { positionMs, ...routedPreparation(record) });
              guard(); requireFacts(parked, record, false);
              if (parked.positionMs !== positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            } else if (record.opened || positionMs !== record.originMs || parked.positionMs !== record.originMs) {
              parked = await control.seek(record.session, positionMs); guard(); requireFacts(parked, record, false);
            }
            record.originMs = parked.positionMs; record.opened = true;
            const read = { owner: consumer, intent, positionMs: parked.positionMs, controller: new AbortController() };
            record.read = read;
            const abort = () => {
              if (record.read !== read) return;
              invalidateRead(record); const parkedIntent = ++record.intent;
              const parkedGuard = () => { if (record.intent !== parkedIntent || record.outputOwner !== consumer) throw fail('CANCELLED'); };
              void enqueue(record, parkedGuard, async () => { const paused = await control.pause(record.session); parkedGuard(); requireFacts(paused, record, false); confirmRoutePaused(record); await holdRoutes(record); })
                .catch(error => { if (record.intent === parkedIntent && !record.releasing) operationError(record, error); });
            };
            signal?.addEventListener('abort', abort, { once: true }); read.detach = () => signal?.removeEventListener('abort', abort);
            if (signal?.aborted) { abort(); throw fail('CANCELLED'); }
            // The format is expected wire data. Actual capture snapshots remain lazy
            // and must validate before readable() can publish its first PCM frame.
            latestReader = Object.freeze({ stream: readable(record, read), positionMs: read.positionMs,
              transport: Object.freeze({ ...LIVE_PCM_TRANSPORT }), assertCurrent: guard });
            return latestReader;
          });
        } catch (error) { throw operationError(record, error); }
      },
      pause: park,
      stop(options) {
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return Promise.resolve();
        // Preserve the exact failed owner for a later authorized cleanup retry.
        // An aborted public reader must not turn its retained cleanup into success.
        if (record.releasing || record.controller.signal.aborted) return track(release(record));
        return park({ ...options, releaseRoute: true });
      },
      revoke() {
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return Promise.resolve();
        if (current === record) forgetMetadata(record);
        return track(release(record));
      },
    };
  }
  async function run(id, requestId, onProgress = () => {}, quality = 'high') {
    if (!validTrack(id) || !sessionId(requestId) || !['standard', 'high', 'lossless'].includes(quality)) throw publicError(fail('INVALID_AUDIO_REQUEST'));
    if (disposed || jobs.has(requestId)) throw publicError(fail('CANCELLED'));
    const previous = current;
    const record = { revision: ++revision, session: randomUUID(), requestId, trackId: id, controller: new AbortController(),
      controlController: new AbortController(), queue: Promise.resolve(), retiredReads: new Set(), intent: 0, consumerSerial: 0, outputSerial: 0 };
    current = record; jobs.set(requestId, record);
    let stage = 'scope';
    const reads = prefetchSelection && (!officialMetadata || typeof officialMetadata.isCurrent === 'function')
      ? beginPreparationReads(record) : null;
    try {
      await release(previous);
      // A superseded failed preparation can own cleanup even after current changed.
      for (const retained of [...cleanupRecords]) await release(retained);
      own(record); onProgress({ stage: 'connect' });
      let facts, readPreparation;
      let result = reads ? await reads : null; own(record);
      // Restoration may outlast the token's no-refresh window even when both
      // GETs finished early. Recheck without refreshing before accepting them.
      if (result && !result.error && !await vault.token({ allowRefresh: false }))
        result = { error: fail('PREPARATION_READ_DEFERRED') };
      own(record);
      if (result?.error?.code === 'PREPARATION_READ_DEFERRED') {
        // No new source/route writes have occurred. After exact old restoration,
        // discard the read-only grant and reauthorize through the original path.
        record.stamp = undefined; result = null;
      }
      if (result) {
        stage = result.stage || 'scope';
        if (result.error) throw result.error;
        const [track, devices] = result.value;
        stage = 'track-metadata'; facts = await acceptMetadata(record, track.value); own(record);
        readPreparation = devices.value;
      } else {
        const scopes = await vault.grantedScopes(); own(record);
        if (!scopes.scopes?.includes(REQUIRED_DEVICE_SCOPE) || !scopes.scopes?.includes(REQUIRED_PLAYBACK_SCOPE)) throw fail('SCOPE_REQUIRED');
        stage = 'track-metadata'; facts = await metadata(record); own(record);
      }
      record.resolvedTrackId = facts.trackId; record.durationMs = facts.durationMs;
      stage = 'association';
      const selection = await getSelection({ signal: record.controller.signal, session: record.session, preparation: readPreparation }); own(record);
      if (typeof selection?.deviceId !== 'string' || !selection.deviceId || selection.deviceId.length > 256
        || /[\u0000-\u001f\u007f]/.test(selection.deviceId)) throw fail('DEVICE_NOT_SELECTED');
      record.selection = { deviceId: selection.deviceId, ...selectionFields(selection) };
      record.automaticRouting = selection.automaticRouting === true;
      if (record.automaticRouting && !ownedAudio) throw fail('ROUTE_HELPER_UNAVAILABLE');
      if (record.automaticRouting) {
        const availability = await routeLifecycle.availability(); own(record);
        if (!admitted(availability)) throw fail(availability.code || 'ROUTE_HELPER_UNQUALIFIED');
        const bindObservedRoute = async () => {
          own(record);
          record.routeBinding = (await routeLifecycle.inspect(record.selection)).binding; own(record);
          Object.assign(record.selection, { expectedSpotifyProcessId: record.routeBinding.expectedSpotifyProcessId,
            expectedSpotifyStartedAtUnixMs: record.routeBinding.expectedSpotifyStartedAtUnixMs });
        };
        record.refreshRouteBinding = bindObservedRoute;
        try { await bindObservedRoute(); }
        catch (error) {
          if (error?.code !== 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN') throw error;
          // Only this precise no-session result permits cold discovery at the current Spotify volume.
          // Ambiguous identity, unsafe policy, feedback and capability failures never start Spotify.
          record.needsColdBootstrap = true;
        }
      } else {
      let configuration = await captureHost.inspectRoute(record.selection); own(record);
      const binding = processBinding(configuration);
      if (configuration?.ready !== true && configuration?.temporaryFormatLeaseEligible === true
        && record.selection.temporaryFormatLease === true && typeof captureHost.formatProbe === 'function') {
        configuration = (await captureHost.formatProbe(record.selection)).configuration; own(record);
      }
      requireConfiguration(configuration, record.selection);
      const afterProbe = processBinding(configuration);
      if (binding.expectedSpotifyProcessId !== afterProbe.expectedSpotifyProcessId
        || binding.expectedSpotifyStartedAtUnixMs !== afterProbe.expectedSpotifyStartedAtUnixMs) throw fail('SPOTIFY_PROCESS_CHANGED');
      Object.assign(record.selection, binding);
      }
      stage = 'pcm-prepare';
      const preparation = control.prepare({ session: record.session, deviceId: record.selection.deviceId,
        trackId: record.resolvedTrackId, durationMs: record.durationMs, positionMs: 0, restoreSavedTarget: true,
        signal: record.controlController.signal, preparationDevices: selection.preparationDevices,
        ...(record.refreshRouteBinding ? { coldBootstrap: record.refreshRouteBinding, coldBootstrapRequired: record.needsColdBootstrap === true } : {}),
        ...(record.automaticRouting ? {
          routedPreparation: routedPreparation(record),
          onRouteParked: () => confirmRoutePaused(record),
        } : {}),
      });
      record.preparationPromise = preparation;
      const prepared = await preparation;
      record.prepared = true; own(record); requireFacts(prepared, record, false); record.originMs = prepared.positionMs;
      confirmRoutePaused(record);
      // Keep this exact route/journal through the first live reader; no restore/reacquire gap.
      own(record);
      stage = 'publish';
      record.handle = await media.add({
        async open({ signal }) { own(record); const source = lookup(record.handle.url); return (await source.openReadable({ positionMs: record.originMs, signal })).stream; },
        close: () => release(record),
      });
      // A cancelled add may finish after release already ran. Revoke its newly
      // returned URL immediately so no orphan media entry can outlive the source.
      if (record.releasing) void Promise.resolve(record.handle.revoke()).catch(() => {});
      own(record); onProgress({ stage: 'validate' });
      return { url: record.handle.url, fetchedAt: now(), requestedQuality: quality, quality: null, actualQuality: null,
        streaming: true, sessionBoundAudio: true, playbackTransport: 'cable-pcm', durationMs: record.durationMs,
        sourceInfo: { codec: null, container: null, encodingVerified: false, sampleRate: null, channels: null,
          bitDepth: null, bitrate: null, bitrateKind: null, lossless: null },
        preparedAudio: { codec: 'PCM', representation: 's32le', sampleFormat: 's32le', sampleRate: RATE, channels: 2, bitDepth: 32 },
        pcmOriginMs: record.originMs };
    } catch (error) {
      const cancelled = record.controller.signal.aborted || current !== record || record.revision !== revision;
      forgetMetadata(record, error);
      if (['AUTH_REQUIRED', 'SESSION_CHANGED'].includes(error?.code)) metadataCache.clear();
      // Record the initiating stage before cleanup can fail and replace its public result.
      const failure = publicError(record.failure || (cancelled ? fail('CANCELLED') : error));
      reportSpotifyPreparationFailure(requestId, stage, error, failure);
      try { await release(record); }
      catch (cleanupError) {
        reportSpotifyPreparationFailure(requestId, 'cleanup', error, cleanupError);
        throw cleanupError;
      }
      if (current === record) current = null;
      throw failure;
    } finally { if (jobs.get(requestId) === record) jobs.delete(requestId); }
  }
  return {
    prepare(...args) { return track(run(...args)); }, lookup, revokeSession,
    cancel(requestId) { const record = jobs.get(requestId) || (current?.requestId === requestId ? current : null); if (record) { forgetMetadata(record); void track(release(record)); } },
    async clear({ verifyCaptureStop = false } = {}) {
      metadataCache.clear(); metadataStamp = undefined;
      ++revision; const previous = current; current = null;
      const records = new Set([...cleanupRecords, ...jobs.values(), ...(previous ? [previous] : [])]);
      const results = await Promise.allSettled([...records].map(record => release(record)));
      await Promise.allSettled([...pending]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (verifyCaptureStop) {
        await previous?.queue.catch(() => {});
        if (typeof captureHost.verifyStopped !== 'function') throw fail('CAPTURE_HELPER_EXIT_UNCONFIRMED');
        await captureHost.verifyStopped();
      }
    },
    async close() {
      disposed = true;
      try { await this.clear(); await media.close(); }
      catch (error) { if (isRetryableRouteCleanup(error)) disposed = false; throw error; }
    },
  };
}
module.exports = { createCableAudioPreparation };
