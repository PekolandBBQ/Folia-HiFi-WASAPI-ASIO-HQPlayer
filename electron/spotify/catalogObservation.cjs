'use strict';
const { REQUIRED_DEVICE_SCOPE } = require('./grantScopes.cjs');
const { reportSpotifyHttp } = require('./requestDiagnostics.cjs');
// electron/spotify/catalogObservation.cjs: construction performs no I/O; only explicit readFresh does.
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a?.epoch === b?.epoch && a?.revision === b?.revision;
async function boundedJson(response, stillCurrent, maximumBytes = 262144, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('PROTOCOL_INVALID');
  const chunks = []; let length = 0;
  let abort;
  const aborted = signal && new Promise((_, reject) => { abort = () => reject(signal.reason); });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      stillCurrent(); signal?.throwIfAborted();
      const next = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      stillCurrent(); signal?.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw fail('PROTOCOL_INVALID');
      length += next.value.byteLength;
      if (length > maximumBytes) throw fail('PROTOCOL_INVALID');
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { throw fail('PROTOCOL_INVALID'); }
  } catch (error) {
    // A stalled producer cancellation must not extend a supplied request deadline.
    const cancelled = Promise.resolve(reader.cancel()).catch(() => {});
    if (!signal) await cancelled;
    throw error;
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
// Never return tokens, response headers, account IDs in logs, or a general arbitrary URL fetch.
function createCatalogObservation({ vault, cooldown, fetcher = fetch, now = Date.now, timeoutMs = 4000 }) {
  if (!vault || !['token', 'stamp', 'grantedScopes'].every(k => typeof vault[k] === 'function')
    || !cooldown || !['load', 'defer'].every(k => typeof cooldown[k] === 'function')
    || typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('PROTOCOL_INVALID');
  async function readFresh({ expectedStamp, signal, allowNoPlayback = false, devicesOnly = false } = {}) {
    if (expectedStamp && !same(expectedStamp, vault.stamp())) throw fail('SESSION_CHANGED');
    const before = await vault.grantedScopes();
    if (!Array.isArray(before.scopes)) throw fail('SCOPES_UNKNOWN');
    if (!before.scopes.includes(REQUIRED_DEVICE_SCOPE)) throw fail('SCOPE_REQUIRED');
    const retryAt = await cooldown.load();
    if (now() < retryAt) throw Object.assign(fail('RATE_LIMITED'), { retryAt });
    const token = await vault.token();
    if (!token) throw fail('AUTH_REQUIRED');
    const stamp = vault.stamp();
    if (!same(before, stamp) || (expectedStamp && !same(expectedStamp, stamp))) throw fail('SESSION_CHANGED');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const get = async route => {
      if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      const retryAt = await cooldown.load();
      if (now() < retryAt) throw Object.assign(fail('RATE_LIMITED'), { retryAt });
      if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      const response = await fetcher('https://api.spotify.com/v1/' + route, {
        method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        cache: 'no-store', redirect: 'error', signal: requestSignal,
      });
      if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      reportSpotifyHttp({ me: 'playback-profile', 'me/player/devices': 'playback-devices', 'me/player': 'playback-state' }[route], 'GET', response.status);
      if (response.status === 429) {
        const retryAt = await cooldown.defer(response.headers.get('retry-after'));
        throw Object.assign(fail('RATE_LIMITED'), { retryAt });
      }
      if (response.status === 401) throw fail('AUTH_REQUIRED');
      if (response.status === 403) throw fail('API_FORBIDDEN');
      if (response.status === 204) {
        if (allowNoPlayback && route === 'me/player') return null;
        throw fail('PLAYBACK_UNAVAILABLE');
      }
      if (response.status !== 200) throw fail('API_UNAVAILABLE');
      const value = await boundedJson(response, () => {
        if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      });
      if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
      return value;
    };
    // Sequential bounded reads prevent two additional calls after the first service-directed rate limit.
    const user = await get('me'), devices = await get('me/player/devices');
    const playback = devicesOnly ? null : await get('me/player');
    if (!same(stamp, vault.stamp())) throw fail('SESSION_CHANGED');
    return { user, devices, playback, receivedAt: now(), grantStamp: stamp };
  }
  return { readFresh };
}
module.exports = { createCatalogObservation, boundedJson };
