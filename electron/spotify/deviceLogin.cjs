const { randomUUID } = require('node:crypto');
const { spotifyError } = require('./errors.cjs');
const { retryDeadline } = require('./cooldown.cjs');

// Device pairing feeds Folia's existing keyed QR state machine. No token crosses this API.
function createDeviceLogin({ vault, clientId, fetcher = fetch, renderQr, openAuthorization, now = Date.now }) {
  const sessions = new Map();
  let generation = 0;
  const current = (key, entry) => sessions.get(key) === entry && entry.generation === generation;
  function prune() { for (const [key, entry] of sessions) if (entry.expiresAt <= now()) cancel(key); }
  async function begin() {
    prune();
    if (sessions.size >= 4) throw spotifyError('unavailable', 'too-many-login-attempts');
    const expected = generation, epoch = vault.epoch();
    const response = await fetcher('https://accounts.spotify.com/oauth2/device/authorize', {
      method: 'POST', signal: AbortSignal.timeout(25000), redirect: 'error',
      body: new URLSearchParams({ client_id: clientId,
        scope: 'streaming user-read-private playlist-read-private playlist-read-collaborative user-library-read' }),
    });
    if (!response.ok) throw spotifyError('unavailable', 'pairing-unavailable');
    const value = await response.json();
    const rawUrl = value.verification_uri_complete;
    let url;
    try { url = new URL(rawUrl); } catch { throw spotifyError('invalid-response', 'pairing-url'); }
    if (url.protocol !== 'https:' || url.username || url.password || !['accounts.spotify.com', 'spotify.com', 'www.spotify.com'].includes(url.hostname)
      || !value.device_code || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
      throw spotifyError('invalid-response', 'pairing-response');
    }
    const imageUrl = await renderQr(url.href);
    if (expected !== generation || epoch !== vault.epoch()) throw spotifyError('auth-required', 'session-changed');
    const key = randomUUID(), interval = Math.max(5, Number(value.interval) || 5) * 1000;
    sessions.set(key, { generation, epoch, deviceCode: value.device_code, imageUrl, interval,
      nextPollAt: now() + interval, expiresAt: now() + Math.min(value.expires_in, 900) * 1000, state: 'waiting' });
    try { await openAuthorization?.(url.href); } catch { cancel(key); throw spotifyError('unavailable', 'browser-open-failed'); }
    return key;
  }
  async function check(key) {
    const entry = sessions.get(key);
    if (!entry) return { state: 'expired' };
    if (entry.state === 'confirmed' || entry.state === 'error') return { state: entry.state };
    if (now() >= entry.expiresAt) { cancel(key); return { state: 'expired' }; }
    if (entry.pending) return entry.pending;
    if (now() < entry.nextPollAt) return { state: 'waiting' };
    const controller = new AbortController(); entry.controller = controller;
    entry.nextPollAt = now() + entry.interval;
    const task = (async () => {
      const response = await fetcher('https://accounts.spotify.com/api/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
        body: new URLSearchParams({ client_id: clientId, device_code: entry.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      if (!current(key, entry)) return { state: 'expired' };
      if (response.status === 429) {
        entry.interval += 5000;
        entry.nextPollAt = Math.max(now() + entry.interval, retryDeadline(response.headers?.get('retry-after'), now()));
        return { state: 'waiting' };
      }
      const value = await response.json();
      if (!current(key, entry)) return { state: 'expired' };
      if (response.ok) {
        if (!value.access_token || !value.refresh_token || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
          entry.state = 'error'; return { state: 'error' };
        }
        await vault.save({ ...value, clientId, expiresAt: now() + value.expires_in * 1000 }, entry.epoch, () => current(key, entry));
        for (const otherKey of sessions.keys()) if (otherKey !== key) cancel(otherKey);
        entry.state = 'confirmed'; entry.deviceCode = undefined; entry.imageUrl = '';
        return { state: 'confirmed' };
      }
      if (value.error === 'slow_down') entry.interval += 5000;
      entry.nextPollAt = now() + entry.interval;
      if (['authorization_pending', 'slow_down'].includes(value.error)) return { state: 'waiting' };
      if (value.error === 'expired_token') { cancel(key); return { state: 'expired' }; }
      entry.state = 'error'; return { state: 'error' };
    })().finally(() => { entry.pending = null; entry.controller = null; });
    entry.pending = task;
    return task;
  }
  function cancel(key) { const entry = sessions.get(key); sessions.delete(key); entry?.controller?.abort(); }
  return { begin, check, cancel, image: key => sessions.get(key)?.imageUrl || '',
    clear() { generation++; for (const key of sessions.keys()) cancel(key); },
  };
}
module.exports = { createDeviceLogin };
