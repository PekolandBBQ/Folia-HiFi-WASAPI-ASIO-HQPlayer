import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createSessionVault } = createRequire(import.meta.url)('../../../electron/spotify/sessionVault.cjs');

// Test-only storage uses reversible bytes; production always receives Electron safeStorage.
const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const grant = { access_token: 'old', refresh_token: 'refresh', clientId: 'own-client', expiresAt: 0 };
describe('Spotify session vault', () => {
  it('deduplicates refresh, keeps rotated tokens and binds the original client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-'));
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }) });
    const auth = createSessionVault({ directory, safeStorage: storage, fetcher });
    try {
      await auth.save(grant); expect(await Promise.all([auth.token(), auth.token()])).toEqual(['new', 'new']);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].body.get('client_id')).toBe('own-client');
      await auth.clear(); expect(await auth.token()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('never resurrects a refresh after logout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-'));
    let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const auth = createSessionVault({ directory, safeStorage: storage, fetcher: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    try {
      await auth.save(grant); const pending = auth.token(); const rejected = expect(pending).rejects.toThrow('session-changed');
      await entered; await auth.clear(); release({ ok: true, json: async () => ({ access_token: 'late', expires_in: 1000 }) });
      await rejected; expect(await auth.token()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses unavailable encryption and cancelled authorization commits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-'));
    try {
      const unavailable = createSessionVault({ directory, safeStorage: { ...storage, isEncryptionAvailable: () => false } });
      await expect(unavailable.save(grant)).rejects.toThrow('encryption-unavailable');
      const auth = createSessionVault({ directory, safeStorage: storage });
      await expect(auth.save(grant, auth.epoch(), () => false)).rejects.toThrow('session-changed');
      expect(await auth.token()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('Spotify granted scope and authorization revision', () => {
  const scopeGrant = { ...grant, expiresAt: 200000, scope: 'user-read-playback-state user-read-private' };
  async function withVault(run: (auth: any, directory: string) => Promise<void>, fetcher?: any) {
    const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-scopes-'));
    const auth = createSessionVault({ directory, safeStorage: storage, fetcher, now: () => 1000 });
    try { await run(auth, directory); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it('persists normalized returned scope and exposes only frozen permission metadata', async () => {
    await withVault(async auth => {
      await auth.save({ ...scopeGrant, scope: 'user-read-private user-read-playback-state user-read-private' });
      const metadata = await auth.grantedScopes();
      expect(metadata.scope).toBe('user-read-playback-state user-read-private');
      expect(Object.keys(metadata)).toEqual(['epoch', 'revision', 'scope', 'scopes']);
      expect(metadata.scopes).toEqual(['user-read-playback-state', 'user-read-private']);
      expect(Object.isFrozen(metadata)).toBe(true); expect(Object.isFrozen(metadata.scopes)).toBe(true);
      expect(JSON.stringify(metadata)).not.toContain(scopeGrant.access_token);
      expect(JSON.stringify(metadata)).not.toContain(scopeGrant.refresh_token);
    });
  });
  it('inherits omitted refresh scope without substituting requested permissions', async () => {
    await withVault(async auth => {
      await auth.save({ ...scopeGrant, expiresAt: 0 });
      expect(await auth.token()).toBe('renewed');
      expect((await auth.grantedScopes()).scope).toBe(scopeGrant.scope);
    }, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'renewed', expires_in: 3600 }) }));
  });
  it.each(['user-read-private', ''])('replaces refresh scope with explicit returned scope %j', async scope => {
    await withVault(async auth => {
      await auth.save({ ...scopeGrant, expiresAt: 0 }); await auth.token();
      expect((await auth.grantedScopes()).scope).toBe(scope);
      expect((await auth.grantedScopes()).scopes).not.toContain('user-read-playback-state');
    }, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'renewed', expires_in: 3600, scope }) }));
  });
  it('keeps legacy permission scope unknown after an omitted-scope refresh', async () => {
    await withVault(async (auth, directory) => {
      // Generated test-only legacy bytes, never a real account vault.
      await writeFile(join(directory, 'session.enc'), storage.encryptString(JSON.stringify(grant)));
      expect((await auth.grantedScopes()).scopes).toBeNull(); await auth.token();
      expect((await auth.grantedScopes()).scopes).toBeNull();
    }, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'renewed', expires_in: 3600 }) }));
  });
  it('rejects invalid scope without changing a committed revision or writing a session', async () => {
    await withVault(async (auth, directory) => {
      const initial = auth.stamp();
      await expect(auth.save({ ...scopeGrant, scope: ['invalid'] })).rejects.toMatchObject({ code: 'invalid-response' });
      expect(auth.stamp()).toEqual(initial); expect(await readdir(directory)).toEqual([]);
      await auth.save(scopeGrant); expect(auth.stamp().revision).toBe(initial.revision + 1);
      const committed = auth.stamp();
      await expect(auth.save({ ...scopeGrant, scope: 'invalid\tpermission' })).rejects.toMatchObject({ code: 'invalid-response' });
      expect(auth.stamp()).toEqual(committed);
      await auth.clear(); expect(auth.stamp().revision).toBeGreaterThan(committed.revision);
      expect(auth.stamp().epoch).toBeGreaterThan(committed.epoch);
    });
  });
  it('rejects an old refresh after a new grant commits in the same logout epoch', async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    await withVault(async auth => {
      await auth.save({ ...scopeGrant, expiresAt: 0 });
      const stale = auth.token(); const rejected = expect(stale).rejects.toThrow('session-changed');
      await started; const oldEpoch = auth.epoch();
      await auth.save({ ...scopeGrant, access_token: 'new-authorization', scope: 'user-read-private' });
      const committed = auth.stamp(); expect(auth.epoch()).toBe(oldEpoch);
      expect(await auth.token()).toBe('new-authorization');
      release({ ok: true, json: async () => ({ access_token: 'stale-refresh', expires_in: 3600, scope: scopeGrant.scope }) });
      await rejected; expect(auth.stamp()).toEqual(committed);
      expect(await auth.token()).toBe('new-authorization'); expect((await auth.grantedScopes()).scope).toBe('user-read-private');
    }, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  });
  it('starts a fresh refresh for a newer grant instead of joining old in-flight work', async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetcher = vi.fn().mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); })
      .mockResolvedValue({ ok: true, json: async () => ({ access_token: 'newer-renewed', expires_in: 3600, scope: 'user-read-private' }) });
    await withVault(async auth => {
      await auth.save({ ...scopeGrant, expiresAt: 0 });
      const stale = auth.token(); const rejected = expect(stale).rejects.toThrow('session-changed'); await started;
      await auth.save({ ...scopeGrant, access_token: 'newer-expired', refresh_token: 'newer-refresh', expiresAt: 0, scope: 'user-read-private' });
      expect(await auth.token()).toBe('newer-renewed'); expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][1].body.get('refresh_token')).toBe('newer-refresh');
      release({ ok: true, json: async () => ({ access_token: 'old-renewed', expires_in: 3600, scope: scopeGrant.scope }) });
      await rejected; expect(await auth.token()).toBe('newer-renewed'); expect((await auth.grantedScopes()).scope).toBe('user-read-private');
    }, fetcher);
  });
});
