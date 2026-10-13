const fs = require('node:fs/promises');
const path = require('node:path');
const { spotifyError } = require('./errors.cjs');
const { normalizeScope, mergeGrantedScope } = require('./grantScopes.cjs');
const { reportSpotifyScopes } = require('./requestDiagnostics.cjs');

// A dedicated Spotify vault; never read credentials from another app or historical test profile.
function createSessionVault({ directory, safeStorage, fetcher = fetch, now = Date.now, diagnosticScopes = false }) {
  const file = path.join(directory, 'session.enc');
  let generation = 0, revision = 0, writeIntent = 0, refreshing, refreshingStamp, refreshRequest, writes = Promise.resolve(), snapshot;
  const invalidateSnapshot = () => { snapshot = undefined; writeIntent++; };
  const enqueue = action => { const task = writes.catch(() => {}).then(action); writes = task; return task; };
  async function read() {
    await writes.catch(() => {});
    try { return JSON.parse(safeStorage.decryptString(await fs.readFile(file))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw spotifyError('auth-required', 'session-unreadable'); }
  }
  // Main-process memory only. Never retain the refresh token or trust this across
  // a queued grant write, logout, clock rollback, expiry, or five seconds.
  async function readSnapshot() {
    await writes.catch(() => {});
    const at = now(), expected = generation, expectedRevision = revision, intent = writeIntent;
    if (snapshot && snapshot.epoch === expected && snapshot.revision === expectedRevision
      && snapshot.intent === intent && at >= snapshot.observedAt && at - snapshot.observedAt < 5000)
      return snapshot.value;
    snapshot = undefined;
    const value = await read();
    if (expected !== generation || expectedRevision !== revision || intent !== writeIntent)
      throw spotifyError('auth-required', 'session-changed');
    const limited = value ? Object.freeze({ access_token: value.access_token, expiresAt: value.expiresAt,
      scope: normalizeScope(value.scope) }) : null;
    snapshot = { epoch: expected, revision: expectedRevision, intent, observedAt: at, value: limited };
    return limited;
  }
  async function save(value, expected = generation, stillCurrent = () => true) {
    if (!value?.access_token || !value.refresh_token || !value.clientId || !Number.isFinite(value.expiresAt)) {
      throw spotifyError('invalid-response', 'invalid-session');
    }
    const stored = { ...value, scope: normalizeScope(value.scope) };
    if (!safeStorage.isEncryptionAvailable()) throw spotifyError('unavailable', 'encryption-unavailable');
    invalidateSnapshot();
    return enqueue(async () => {
      if (expected !== generation || !stillCurrent()) throw spotifyError('auth-required', 'session-changed');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(file + '.tmp', safeStorage.encryptString(JSON.stringify(stored)), { mode: 0o600 });
      // Logout invalidates even an in-flight disk write before committing it.
      if (expected !== generation || !stillCurrent()) { await fs.rm(file + '.tmp', { force: true }); throw spotifyError('auth-required', 'session-changed'); }
      await fs.rename(file + '.tmp', file);
      revision++;
    });
  }
  async function token({ allowRefresh = true } = {}) {
    if (!allowRefresh) {
      // Speculative preparation must never refresh credentials or advance the
      // account revision while an older source still owns route restoration.
      if (refreshRequest) return null;
      const expected = generation, expectedRevision = revision, intent = writeIntent;
      const current = await readSnapshot();
      if (expected !== generation || expectedRevision !== revision || intent !== writeIntent)
        throw spotifyError('auth-required', 'session-changed');
      if (refreshRequest || !current || current.expiresAt <= now() + 60000) return null;
      return current.access_token;
    }
    if (refreshing && refreshingStamp?.epoch === generation && refreshingStamp.revision === revision
      && refreshingStamp.intent === writeIntent) return refreshing;
    const expected = generation, expectedRevision = revision, expectedIntent = writeIntent;
    const task = (async () => {
      let current = await readSnapshot();
      if (expected !== generation || expectedRevision !== revision || expectedIntent !== writeIntent)
        throw spotifyError('auth-required', 'session-changed');
      if (diagnosticScopes) reportSpotifyScopes(current?.scope);
      if (!current) return null;
      if (current.expiresAt > now() + 60000) return current.access_token;
      refreshRequest = task;
      current = await read();
      if (!current || expected !== generation || expectedRevision !== revision || expectedIntent !== writeIntent)
        throw spotifyError('auth-required', 'session-changed');
      const response = await fetcher('https://accounts.spotify.com/api/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh_token, client_id: current.clientId }),
      });
      if (!response.ok) throw spotifyError(response.status === 400 || response.status === 401 ? 'auth-required' : 'network', 'refresh-failed');
      const next = await response.json();
      if (!next.access_token || !Number.isFinite(next.expires_in) || next.expires_in <= 0) throw spotifyError('invalid-response', 'invalid-expiry');
      if (expected !== generation || expectedRevision !== revision) throw spotifyError('auth-required', 'session-changed');
      await save({ ...current, ...next, scope: mergeGrantedScope(current.scope, next, { refresh: true }),
        expiresAt: now() + next.expires_in * 1000 }, expected, () => revision === expectedRevision);
      if (expected !== generation || revision !== expectedRevision + 1 || writeIntent !== expectedIntent + 1)
        throw spotifyError('auth-required', 'session-changed');
      if (diagnosticScopes) reportSpotifyScopes(mergeGrantedScope(current.scope, next, { refresh: true }));
      return next.access_token;
    })();
    refreshing = task; refreshingStamp = { epoch: expected, revision: expectedRevision, intent: expectedIntent };
    try { return await task; } finally {
      if (refreshing === task) refreshing = null;
      if (refreshRequest === task) refreshRequest = null;
    }
  }
  return { save, token, epoch: () => generation,
    stamp: () => Object.freeze({ epoch: generation, revision }),
    async grantedScopes() {
      const expected = generation, expectedRevision = revision;
      const value = await readSnapshot();
      if (expected !== generation || expectedRevision !== revision) throw spotifyError('auth-required', 'session-changed');
      const scope = normalizeScope(value?.scope);
      return Object.freeze({ epoch: generation, revision, scope,
        scopes: scope === null ? null : Object.freeze(scope ? scope.split(' ') : []) });
    },
    dispose() { invalidateSnapshot(); },
    async clear() { invalidateSnapshot(); generation++; revision++; refreshing = null; await enqueue(async () => {
      await fs.rm(file, { force: true }); await fs.rm(file + '.tmp', { force: true });
    }); },
  };
}
module.exports = { createSessionVault };
