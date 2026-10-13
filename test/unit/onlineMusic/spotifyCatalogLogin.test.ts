import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { createCatalogLogin } = createRequire(import.meta.url)('../../../electron/spotify/catalogLogin.cjs');

// Real loopback callbacks with fake Spotify replies validate PKCE, state and cancellation boundaries.
function fixture(returned: Record<string, unknown> = {}) {
  let authorization: URL;
  const vault = { epoch: () => 0, save: vi.fn(async (..._args: unknown[]) => {}) };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, ...returned }) }));
  const auth = createCatalogLogin({ vault, fetcher, port: 0, renderQr: async () => 'image', openAuthorization: async (url: string) => { authorization = new URL(url); } });
  const callback = (state?: string) => {
    const url = new URL(authorization.searchParams.get('redirect_uri')!);
    url.searchParams.set('code', 'fake-code'); url.searchParams.set('state', state ?? authorization.searchParams.get('state')!); return url;
  };
  return { auth, vault, fetcher, callback, url: () => authorization };
}
describe('Spotify catalog PKCE authorization', () => {
  it('rejects wrong state then exchanges one valid callback using PKCE without a client secret', async () => {
    const f = fixture();
    try {
      const key = await f.auth.begin(); expect(f.auth.check(key)).toEqual({ state: 'waiting' });
      expect((await fetch(f.callback('wrong'))).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
      const complete = await fetch(f.callback());
      expect(complete.status).toBe(200); expect(new URL(complete.url).search).toBe('');
      expect(complete.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await complete.text()).toContain('Authorization complete');
      expect(f.auth.check(key)).toEqual({ state: 'confirmed' });
      const options = (f.fetcher.mock.calls as any)[0][1];
      expect(options.body.has('client_secret')).toBe(false);
      expect(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url')).toBe(f.url().searchParams.get('code_challenge'));
      expect(f.vault.save).toHaveBeenCalledTimes(1); expect(f.auth.image(key)).toBe('');
    } finally { f.auth.clear(); }
  });
  it('cancels an in-flight exchange before it can save credentials', async () => {
    const f = fixture(); let resolve!: (value: any) => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    f.fetcher.mockImplementation(() => { entered(); return new Promise(r => { resolve = r; }); });
    try {
      const key = await f.auth.begin(); const pending = fetch(f.callback()).catch(() => null);
      await started; f.auth.cancel(key); resolve({ ok: true, json: async () => ({ access_token: 'late', refresh_token: 'late', expires_in: 3600 }) });
      await pending; await new Promise(r => setTimeout(r, 0));
      expect(f.vault.save).not.toHaveBeenCalled(); expect(f.auth.check(key).state).toBe('expired');
    } finally { f.auth.clear(); }
  });
  it('reports denied consent without sending a token request', async () => {
    const f = fixture();
    try {
      const key = await f.auth.begin(), url = f.callback(); url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied');
      await fetch(url).catch(() => null); expect(f.auth.check(key).state).toBe('error'); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.auth.clear(); }
  });
});

describe('Spotify catalog granted permission metadata', () => {
  it('requests catalog access and the official device playback permissions', async () => {
    const f = fixture();
    try {
      await f.auth.begin();
      expect(f.url().searchParams.get('scope')!.split(' ').sort()).toEqual([
        'playlist-read-collaborative', 'playlist-read-private', 'user-library-read', 'user-modify-playback-state', 'user-read-playback-state', 'user-read-private',
      ]);
    } finally { f.auth.clear(); }
  });
  it.each([{ scope: 'user-read-private user-read-playback-state user-read-private', expected: 'user-read-playback-state user-read-private' },
    { scope: undefined, expected: null }])('saves actual returned scope instead of the authorization request: $expected', async ({ scope, expected }) => {
    const f = fixture(scope === undefined ? {} : { scope });
    try {
      const key = await f.auth.begin(); expect((await fetch(f.callback())).status).toBe(200);
      expect(f.auth.check(key)).toEqual({ state: 'confirmed' });
      expect(f.vault.save.mock.calls[0][0]).toMatchObject({ scope: expected });
    } finally { f.auth.clear(); }
  });
  it('refuses malformed returned permission metadata before saving credentials', async () => {
    const f = fixture({ scope: [] });
    try {
      const key = await f.auth.begin(); expect((await fetch(f.callback())).status).toBe(400);
      expect(f.vault.save).not.toHaveBeenCalled(); expect(f.auth.check(key).state).toBe('error');
    } finally { f.auth.clear(); }
  });
});
