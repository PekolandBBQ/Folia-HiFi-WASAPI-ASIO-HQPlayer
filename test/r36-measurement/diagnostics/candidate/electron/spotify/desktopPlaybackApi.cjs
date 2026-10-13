'use strict';
const { performance } = require('node:perf_hooks');
const { boundedJson } = require('./catalogObservation.cjs');
const { REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE } = require('./grantScopes.cjs');
const { fail, failureCode, sameStamp } = require('./desktopPlaybackFacts.cjs');
const { reportSpotifyHttp, reportSpotifyPlaybackControl, pauseResponseFields } = require('./requestDiagnostics.cjs');
const { inspectRejectedPauseResponse } = require('../debug/pauseResponseInspection.cjs');

// electron/spotify/desktopPlaybackApi.cjs: fixed official endpoints with bounded reads and the catalog's shared cooldown.
async function readControlAcknowledgment(response, current, signal, observation, operation) {
  // Raw inspection remains the pre-existing, opt-in pause-only diagnostic.
  const inspect = bytes => { if (operation === 'pause') inspectRejectedPauseResponse(bytes); };
  const check = () => { current(); signal.throwIfAborted(); };
  check();
  if (response.body === null) { observation.bodyShape = 'empty'; return 'UNCONFIRMED'; }
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('PROTOCOL_INVALID');
  const chunks = [];
  let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try {
    // Bound both bytes and the entire drain, including a stream stalled after headers.
    for (;;) {
      check(); const next = await Promise.race([reader.read(), aborted]); check();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw fail('PROTOCOL_INVALID');
      observation.bodyBytes = Math.min(4097, observation.bodyBytes + next.value.byteLength);
      if (observation.bodyBytes > 4096) { observation.bodyShape = 'too-large'; throw fail('PROTOCOL_INVALID'); }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks, observation.bodyBytes);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { observation.bodyShape = 'invalid-utf8'; check(); inspect(bytes); throw fail('PROTOCOL_INVALID'); }
    if (/^[ \t\r\n]*$/.test(text)) { observation.bodyShape = 'empty'; return 'UNCONFIRMED'; }
    let body;
    try { body = JSON.parse(text); }
    catch {
      observation.bodyShape = text.startsWith('\uFEFF') ? 'bom-text' : 'invalid-text';
      // An undocumented opaque text reply carries no success semantics. Only the
      // control layer's subsequent state observations may complete this operation.
      if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uFEFF]/.test(text) && text.trim().length) {
        observation.bodyShape = 'plain-text'; return 'UNCONFIRMED';
      }
      check(); inspect(bytes); throw fail('PROTOCOL_INVALID');
    }
    if (body === null) { observation.bodyShape = 'null'; return 'UNCONFIRMED'; }
    if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
      observation.bodyShape = 'empty-object'; return 'UNCONFIRMED';
    }
    observation.bodyShape = typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'error')
      ? 'error-json' : 'nonempty-json';
    check(); inspect(bytes);
    throw fail('PROTOCOL_INVALID');
  } catch (error) {
    if (observation.bodyShape === 'unknown') observation.bodyShape = 'unreadable';
    // A broken producer may never finish cancel(); it must not extend the deadline.
    Promise.resolve(reader.cancel()).catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

// A transport that ignores AbortSignal must not hold a mutation barrier forever.
async function boundedFetch(action, signal, current) {
  current(); signal.throwIfAborted();
  let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try { const result = await Promise.race([action(), aborted]); current(); signal.throwIfAborted(); return result; }
  catch (error) { current(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}

function createDesktopPlaybackApi({ vault, cooldown, fetcher = fetch, now = Date.now, timeoutMs = 4000 }) {
  const unresolvedWrites = new Set();
  if (!vault || !['token', 'stamp', 'grantedScopes'].every(key => typeof vault[key] === 'function')
    || !cooldown || !['load', 'defer'].every(key => typeof cooldown[key] === 'function')
    || typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('PROTOCOL_INVALID');

  async function authorize(current, { readOnly = false } = {}) {
    current();
    // Refresh before fixing the lease stamp. A later grant revision must revoke the lease.
    const token = readOnly ? await vault.token({ allowRefresh: false }) : await vault.token(); current();
    if (!token) throw fail(readOnly ? 'PREPARATION_READ_DEFERRED' : 'AUTH_REQUIRED');
    const scopes = await vault.grantedScopes(); current();
    if (!Array.isArray(scopes?.scopes)) throw fail('SCOPES_UNKNOWN');
    if (![REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE].every(scope => scopes.scopes.includes(scope))) throw fail('SCOPE_REQUIRED');
    if (!sameStamp(scopes, vault.stamp())) throw fail('SESSION_CHANGED');
    return vault.stamp();
  }

  async function request(operation, record, current, { signal, positionMs, volumePercent } = {}) {
    const routes = { devices: ['GET', 'me/player/devices'], state: ['GET', 'me/player'], transfer: ['PUT', 'me/player'],
      select: ['PUT', 'me/player/play'], play: ['PUT', 'me/player/play'], pause: ['PUT', 'me/player/pause'], seek: ['PUT', 'me/player/seek'], volume: ['PUT', 'me/player/volume'] };
    const route = routes[operation];
    if (!route || operation === 'volume' && (!Number.isInteger(volumePercent) || volumePercent < 0 || volumePercent > 100)) throw fail('PROTOCOL_INVALID');
    const assertCurrent = () => {
      current();
      if (!sameStamp(record.stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      if (signal?.aborted) throw fail('CANCELLED');
    };
    assertCurrent();
    const retryAt = await cooldown.load(); assertCurrent();
    if (now() < retryAt) throw Object.assign(fail('RATE_LIMITED'), { retryAt });
    const token = record.readOnly ? await vault.token({ allowRefresh: false }) : await vault.token(); assertCurrent();
    if (!token) throw fail(record.readOnly ? 'PREPARATION_READ_DEFERRED' : 'AUTH_REQUIRED');
    const [method, endpoint] = route, url = new URL('https://api.spotify.com/v1/' + endpoint);
    if (method === 'PUT' && operation !== 'transfer') url.searchParams.set('device_id', record.deviceId);
    if (operation === 'seek') url.searchParams.set('position_ms', String(positionMs));
    if (operation === 'volume') url.searchParams.set('volume_percent', String(volumePercent));
    // Transfer accepts exactly one saved target. play:false preserves Spotify's current
    // play/pause state; it is not a promise to pause and never runs from an observation.
    const body = operation === 'transfer' ? { device_ids: [record.deviceId], play: false }
      : operation === 'select' ? { uris: [`spotify:track:${record.trackId}`], position_ms: positionMs } : undefined;
    if (method === 'PUT') record.mutationPending = true;
    const requestSignal = AbortSignal.any([record.controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let httpStartedAt;
    const send = () => {
      const write = method === 'PUT' ? {} : null;
      if (write) unresolvedWrites.add(write);
      // Observe the actual producer, outside the cancellation race. A timed-out
      // request remains pending until its producer responds; a rejection with no
      // response remains unknown because it may already have reached Spotify.
      httpStartedAt = performance.now();
      const produced = (async () => fetcher(url.href, { method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error',
        signal: requestSignal,
      }))();
      if (write) produced.then(() => unresolvedWrites.delete(write), () => {});
      return produced;
    };
    const response = await boundedFetch(send, requestSignal, assertCurrent);
    // Dispatch through response headers only; excludes authorization, body drain and state confirmation.
    const elapsedMs = Math.round(performance.now() - httpStartedAt);
    const diagnosticEndpoint = { devices: 'playback-devices', state: 'playback-state', transfer: 'playback-transfer', select: 'playback-select',
      play: 'playback-play', pause: 'playback-pause', seek: 'playback-seek', volume: 'playback-volume' }[operation];
    reportSpotifyHttp(diagnosticEndpoint, method, response.status, undefined, undefined, undefined, elapsedMs);
    const acknowledgment = method === 'PUT' && response.status === 200
      ? { bodyShape: 'unknown', bodyBytes: 0, ...pauseResponseFields(response) } : undefined;
    try {
      assertCurrent();
      if (method === 'PUT' && [401, 403, 404, 429].includes(response.status)) record.mutationPending = false;
      if (response.status === 429) {
        const next = await cooldown.defer(response.headers.get('retry-after')); assertCurrent();
        throw Object.assign(fail('RATE_LIMITED'), { retryAt: next });
      }
      if (response.status === 401) throw fail('AUTH_REQUIRED');
      if (response.status === 403) throw fail('API_FORBIDDEN');
      if (response.status === 404) throw fail('PLAYBACK_UNAVAILABLE');
      if (method === 'PUT') {
        // Every eligible 200 is ambiguous, including an empty/null/empty-object
        // reply. Only the operation-specific state gate may complete it.
        if (acknowledgment) {
          const result = await readControlAcknowledgment(response, assertCurrent, requestSignal, acknowledgment, operation);
          assertCurrent(); requestSignal.throwIfAborted();
          reportSpotifyPlaybackControl(diagnosticEndpoint, method, response.status, { phase: 'unconfirmed', ...acknowledgment });
          return { acknowledgment: result };
        }
        if (response.status !== 204) throw fail(response.ok ? 'PROTOCOL_INVALID' : 'API_UNAVAILABLE');
        requestSignal.throwIfAborted();
        return null;
      }
      if (response.status === 204 && operation === 'state') return null;
      if (response.status !== 200) throw fail('API_UNAVAILABLE');
      const result = await boundedJson(response, assertCurrent, undefined, requestSignal); assertCurrent(); requestSignal.throwIfAborted();
      // Only the explicit GET 204 branch means an empty player. A JSON null 200
      // must not alias that exception during target restoration.
      if (operation === 'state' && result === null) throw fail('PROTOCOL_INVALID');
      return result;
    } catch (error) {
      reportSpotifyPlaybackControl(diagnosticEndpoint, method, response.status,
        { phase: 'failed', errorCode: failureCode(error), ...acknowledgment });
      throw error;
    }
  }
  return { authorize, request, hasUnsettledWrites: () => unresolvedWrites.size > 0 };
}

module.exports = { createDesktopPlaybackApi };
