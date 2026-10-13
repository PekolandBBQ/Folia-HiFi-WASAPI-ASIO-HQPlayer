import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// test/unit/onlineMusic/spotifyAssociationComposition.test.ts — actual service grant and cooldown composition.
const require = createRequire(import.meta.url);
const { createSpotifyService } = require('../../../electron/spotify/service.cjs');
const { createSessionVault } = require('../../../electron/spotify/sessionVault.cjs');
const clientId = 'a'.repeat(32), uri = 'spotify:track:' + 'b'.repeat(22);
const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const owner = { pid: 20, startTicks: '200', uid: 1000, wsPort: 9090, zeroConfPort: 7777,
  executableDevice: 1, executableInode: 123, executableSha256: 'c'.repeat(64),
  wsSocketPid: 20, zeroConfSocketPid: 20, wsSocketStartTicks: '200', zeroConfSocketStartTicks: '200' };
function response(value: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => status === 429 ? '120' : null },
    json: async () => value,
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(JSON.stringify(value))); controller.close(); } }) };
}
async function fixture({ scope = 'user-read-playback-state', fetcher, soloistPcmClient, soloistDeviceName = 'Test Soloist' }: { scope?: string | null; fetcher?: any; soloistPcmClient?: any; soloistDeviceName?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-composition-'));
  // Generated fake records only; construction and tests never access an actual login directory.
  const vault = createSessionVault({ directory: join(directory, 'web-api', clientId), safeStorage: storage });
  await vault.save({ access_token: 'test-access', refresh_token: 'test-refresh', clientId, expiresAt: Date.now() + 3600000, scope });
  let position = 10000;
  const guest = { readFresh: vi.fn(async (_options?: { signal?: AbortSignal }) => ({ owner, receivedAt: Date.now(), authState: { logged_in: true, is_active: true },
    playback: { uri, status: 'paused', speed: 0, positionMs: position, durationMs: 120000 },
    zeroConf: { deviceID: 'unproven-zc-id', status: 101, spotifyError: 0 } })),
    seekOwnedPaused: vi.fn(async (request: any) => { expect(request.expectedPositionMs).toBe(position); position = request.positionMs; return { acknowledged: true }; }) };
  const api = vi.fn(fetcher || (async (url: string, init: any) => {
    if (init?.method === 'PUT') return response(null, 204);
    const route = new URL(url).pathname;
    return response(route.endsWith('/devices') ? { devices: [{ id: 'api-device', is_active: true, is_restricted: false, name: 'Test Soloist' }] }
      : route.includes('/tracks/') ? { id: 'b'.repeat(22), type: 'track', uri, duration_ms: 120000 }
      : route.endsWith('/player') ? { device: { id: 'api-device', is_active: true }, is_playing: false,
        item: { type: 'track', uri, duration_ms: 120000 }, progress_ms: position } : { id: 'fake-account' });
  }));
  const service = createSpotifyService({ directory, safeStorage: storage, fetcher: api,
    renderQr: async () => '', catalogClientId: clientId, ownedSoloist: guest, soloistPcmClient, soloistDeviceName });
  return { service, api, guest, position: () => position, dispose: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
describe('Spotify private association uses the actual service grant and catalog cooldown', () => {
  it('the ordinary audio action uses the same catalog grant and an acquired Soloist target with a private native lease', async () => {
    const client = { prepare: vi.fn(async () => ({ positionMs: 0 })), pause: vi.fn(async () => {}), close: vi.fn(async () => {}),
      play: vi.fn(async () => {}), openReadable: vi.fn(), seek: vi.fn(), dispose: vi.fn() };
    const f = await fixture({ scope: 'user-read-playback-state user-modify-playback-state', soloistPcmClient: client });
    try {
      const source = await f.service.request({ action: 'audio', id: 'b'.repeat(22), requestId: '12345678-1234-1234-1234-123456789abc', quality: 'lossless', streaming: true });
      expect(source).toMatchObject({ streaming: true, sessionBoundAudio: true, requestedQuality: 'lossless', actualQuality: null });
      expect(client.prepare).toHaveBeenCalledWith(expect.objectContaining({ trackId: 'b'.repeat(22), positionMs: 0, durationMs: 120000 }));
      expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled(); // Normal selection does not run the separate diagnostic challenge.
      const control = f.api.mock.calls.find(([_url, init]: any[]) => init?.method === 'PUT');
      expect(control?.[0]).toContain('/me/player/play?device_id=api-device');
      expect(f.service.lookupSoloistPcmSource(source.url)).toMatchObject({ sampleRate: 44100, durationMs: 120000 });
      await expect(f.service.request({ action: 'lookupSoloistPcmSource', url: source.url })).rejects.toMatchObject({ code: 'unsupported' });
      expect(JSON.stringify(source)).not.toContain('test-access'); expect(JSON.stringify(source)).not.toContain('api-device');
      await f.service.request({ action: 'logout' }); expect(f.service.lookupSoloistPcmSource(source.url)).toBeNull();
      expect(client.pause).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });
  it('catalog 429 blocks the private reader without a second API request', async () => {
    const f = await fixture({ fetcher: async () => response({}, 429) });
    try {
      await expect(f.service.request({ action: 'search', query: 'test' })).rejects.toThrow('rate-limited');
      const result = await f.service.observeOwnedSoloistAssociation({ authorizePausedChallenge: true });
      expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.reason).toBe('RATE_LIMITED');
      expect(f.api).toHaveBeenCalledTimes(1); expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
  it('cancelling ordinary audio preparation aborts the in-flight owned guest read before catalog or playback mutation', async () => {
    const client = { prepare: vi.fn(), pause: vi.fn(), close: vi.fn(), dispose: vi.fn() };
    const f = await fixture({ scope: 'user-read-playback-state user-modify-playback-state', soloistPcmClient: client });
    let entered!: () => void, cancelled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.guest.readFresh.mockImplementationOnce((options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      const signal = options!.signal!;
      entered(); const abort = () => { cancelled = true; reject(Object.assign(new Error('cancelled-owner-read'), { code: 'CANCELLED' })); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }));
    const requestId = '12345678-1234-1234-1234-123456789abc';
    try {
      const work = f.service.request({ action: 'audio', id: 'b'.repeat(22), requestId, quality: 'high' });
      const rejected = expect(work).rejects.toThrow('request-cancelled');
      await started; await f.service.request({ action: 'cancelAudio', requestId }); await rejected;
      expect(cancelled).toBe(true); expect(f.api).toHaveBeenCalledOnce(); expect(f.api.mock.calls[0][0]).toContain('/tracks/');
      expect(client.prepare).not.toHaveBeenCalled(); expect(f.api.mock.calls.some(([, input]: any[]) => input?.method === 'PUT')).toBe(false);
    } finally { await f.dispose(); }
  });
  it('cancelling ordinary audio preparation aborts the real catalog request and prevents later device reads or play', async () => {
    const client = { prepare: vi.fn(), pause: vi.fn(), close: vi.fn(), dispose: vi.fn() };
    let entered!: () => void, cancelled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture({ scope: 'user-read-playback-state user-modify-playback-state', soloistPcmClient: client,
      fetcher: (_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        entered(); const abort = () => { cancelled = true; reject(new DOMException('aborted', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      }) });
    const requestId = '12345678-1234-1234-1234-123456789abc';
    try {
      const work = f.service.request({ action: 'audio', id: 'b'.repeat(22), requestId, quality: 'high' });
      const rejected = expect(work).rejects.toThrow('request-cancelled');
      await started; await f.service.request({ action: 'cancelAudio', requestId }); await rejected;
      expect(cancelled).toBe(true); expect(f.api).toHaveBeenCalledOnce(); expect(client.prepare).not.toHaveBeenCalled();
      expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
  it('private reader 429 blocks subsequent ordinary catalog requests using the same cooldown', async () => {
    const f = await fixture({ fetcher: async () => response({}, 429) });
    try {
      expect((await f.service.observeOwnedSoloistAssociation({ authorizePausedChallenge: true })).reason).toBe('RATE_LIMITED');
      await expect(f.service.request({ action: 'search', query: 'test' })).rejects.toThrow('rate-limited');
      expect(f.api).toHaveBeenCalledTimes(1); expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
  it('unknown legacy scope rejects before API, guest observation or control', async () => {
    const f = await fixture({ scope: null });
    try {
      expect((await f.service.readCatalogGrantedScopes()).scopes).toBeNull();
      expect((await f.service.observeOwnedSoloistAssociation({ authorizePausedChallenge: true })).reason).toBe('SCOPES_UNKNOWN');
      expect(f.api).not.toHaveBeenCalled(); expect(f.guest.readFresh).not.toHaveBeenCalled(); expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
  it('logout revokes a delayed private observation without returning a verified association', async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const f = await fixture({ fetcher: async () => { entered(); return pending; } });
    try {
      const work = f.service.observeOwnedSoloistAssociation({ authorizePausedChallenge: true });
      await started; await f.service.request({ action: 'logout' }); release(response({ id: 'late-fake-account' }));
      const result = await work; expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.reason).toBe('SESSION_CHANGED');
      expect(f.guest.seekOwnedPaused).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });
  it('keeps engineering challenge private and restores the paused position after fresh paired observations', async () => {
    const f = await fixture();
    try {
      const permissions = await f.service.readCatalogGrantedScopes();
      expect(permissions.scopes).toEqual(['user-read-playback-state']);
      expect(Object.keys(permissions)).toEqual(['epoch', 'revision', 'scope', 'scopes']);
      await expect(f.service.request({ action: 'readCatalogGrantedScopes' })).rejects.toMatchObject({ code: 'unsupported' });
      await expect(f.service.request({ action: 'observeOwnedSoloistAssociation' })).rejects.toMatchObject({ code: 'unsupported' });
      const result = await f.service.observeOwnedSoloistAssociation({ authorizePausedChallenge: true });
      expect(result.canonicalIdentityVerified).toBe(false); expect(result.accountPlaybackAssociation).toBe('verified-by-fresh-challenge');
      expect(result.restoration).toBe('confirmed'); expect(f.position()).toBe(10000);
      expect(f.api).toHaveBeenCalledTimes(9); expect(f.guest.seekOwnedPaused).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('fake-account'); expect(JSON.stringify(result)).not.toContain(uri);
      expect(JSON.stringify(result)).not.toContain('test-access');
    } finally { await f.dispose(); }
  });
});
