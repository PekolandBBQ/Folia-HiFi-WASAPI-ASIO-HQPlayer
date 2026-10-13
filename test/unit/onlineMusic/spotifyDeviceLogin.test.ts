import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { createDeviceLogin } = createRequire(import.meta.url)('../../../electron/spotify/deviceLogin.cjs');

// Fake provider replies cover login lifecycle without accessing any real account or token.
const reply = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const grant = () => reply({ device_code: 'private-device', verification_uri_complete: 'https://accounts.spotify.com/pair?code=example', expires_in: 600, interval: 5 });
const credential = () => reply({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
function fixture() {
  let now = 0;
  const fetcher = vi.fn().mockResolvedValueOnce(grant());
  const vault = { epoch: () => 0, save: vi.fn().mockResolvedValue(undefined) };
  const auth = createDeviceLogin({ vault, clientId: 'test-client', fetcher, renderQr: async () => 'data:image/png;base64,test', now: () => now });
  return { auth, fetcher, vault, advance: (ms: number) => { now += ms; } };
}
describe('Spotify shared QR login contract', () => {
  it('only exposes an opaque key, QR image and state', async () => {
    const f = fixture(); const key = await f.auth.begin();
    expect(key).not.toContain('private'); expect(f.auth.image(key)).toMatch(/^data:image/);
    expect(await f.auth.check(key)).toEqual({ state: 'waiting' }); expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(5000); f.fetcher.mockResolvedValueOnce(credential());
    expect(await f.auth.check(key)).toEqual({ state: 'confirmed' });
    expect(f.auth.image(key)).toBe('');
    expect(f.vault.save).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'test-client', expiresAt: 3605000 }), 0, expect.any(Function));
  });
  it('honors slow_down and never overlaps polling', async () => {
    const f = fixture(); const key = await f.auth.begin(); f.advance(5000);
    f.fetcher.mockResolvedValueOnce(reply({ error: 'slow_down' }, 400));
    expect(await Promise.all([f.auth.check(key), f.auth.check(key)])).toEqual([{ state: 'waiting' }, { state: 'waiting' }]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(5000); await f.auth.check(key); expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(5000); f.fetcher.mockResolvedValueOnce(credential());
    expect(await f.auth.check(key)).toEqual({ state: 'confirmed' });
  });
  it('rejects credential capture hosts and malformed expiration', async () => {
    for (const patch of [{ verification_uri_complete: 'https://attacker.example/pair' }, { verification_uri_complete: 'http://accounts.spotify.com/pair' }, { expires_in: -1 }]) {
      const f = fixture(); f.fetcher.mockReset().mockResolvedValue(reply({ device_code: 'test', verification_uri_complete: 'https://spotify.com/pair', expires_in: 60, ...patch }));
      await expect(f.auth.begin()).rejects.toThrow('pairing-response');
    }
  });
  it('respects a non-JSON rate limit response without early polling', async () => {
    const f = fixture(); const key = await f.auth.begin(); f.advance(5000);
    const json = vi.fn().mockRejectedValue(new Error('not JSON'));
    f.fetcher.mockResolvedValueOnce({ status: 429, ok: false, headers: new Headers({ 'retry-after': '120' }), json });
    expect(await f.auth.check(key)).toEqual({ state: 'waiting' });
    f.advance(119000); await f.auth.check(key); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(json).not.toHaveBeenCalled();
    f.advance(1000); f.fetcher.mockResolvedValueOnce(credential()); expect(await f.auth.check(key)).toEqual({ state: 'confirmed' });
  });
  it('expires and permits idempotent cancellation', async () => {
    const f = fixture(); const key = await f.auth.begin(); f.advance(600000);
    expect(await f.auth.check(key)).toEqual({ state: 'expired' });
    f.auth.cancel(key); f.auth.cancel('unknown'); expect(f.vault.save).not.toHaveBeenCalled();
  });
  it('cannot save a response arriving after the window closes', async () => {
    const f = fixture(); const key = await f.auth.begin(); f.advance(5000);
    let release!: (value: unknown) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.auth.check(key); f.auth.cancel(key); release(credential());
    expect(await pending).toEqual({ state: 'expired' }); expect(f.vault.save).not.toHaveBeenCalled();
  });
  it('invalidates a login that finishes its initial request after logout', async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    f.fetcher.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.auth.begin(); f.auth.clear(); release(grant());
    await expect(pending).rejects.toThrow('session-changed');
  });
  it('does not treat an access denial or malformed credential as success', async () => {
    for (const response of [reply({ error: 'access_denied' }, 400), reply({ access_token: 'only-access', expires_in: 1 })]) {
      const f = fixture(); const key = await f.auth.begin(); f.advance(5000); f.fetcher.mockResolvedValueOnce(response);
      expect(await f.auth.check(key)).toEqual({ state: 'error' }); expect(f.vault.save).not.toHaveBeenCalled();
    }
  });
});
