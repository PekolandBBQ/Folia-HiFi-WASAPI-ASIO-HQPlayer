import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// test/unit/onlineMusic/spotifyServiceLogin.test.ts: actual login/vault composition with fake browser, HTTP and native boundaries only.
const require = createRequire(import.meta.url);
const { createSessionVault } = require('../../../electron/spotify/sessionVault.cjs');
const { createAudioPreparation } = require('../../../electron/spotify/audioPreparation.cjs');
const { createSoloistAudioPreparation } = require('../../../electron/spotify/soloistAudioPreparation.cjs');
const clientId = 'a'.repeat(32), deviceClientId = '65b708073fc0480ea92a077233ca87bd';
const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.restoreAllMocks(); } });

function loadModule(file: string, overrides: Record<string, unknown>) {
  const source = new URL('../../../electron/spotify/' + file, import.meta.url), originalRequire = createRequire(source);
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(source, 'utf8'), { module, exports: module.exports,
    require: (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name),
    URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, Date, Buffer, process,
  }, { filename: fileURLToPath(source) });
  return module.exports;
}

function reply(value: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value }; }

// Execute the real callback handler in memory: no listening sockets or real browser are involved.
async function fixture({ legacy = 'missing', soloist = true, pcm = true, nativeEnabled = true,
  tokenReply = { access_token: 'fake-catalog-access', refresh_token: 'fake-catalog-refresh', expires_in: 3600, scope: 'user-read-private' },
}: { legacy?: 'missing' | 'expired' | 'unreadable' | 'valid'; soloist?: boolean; pcm?: boolean; nativeEnabled?: boolean; tokenReply?: Record<string, unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-login-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const catalogDirectory = join(directory, 'web-api', clientId);
  const legacyFile = join(directory, 'session.enc');
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  if (legacy === 'unreadable') await writeFile(legacyFile, 'fake-unreadable-session');
  else if (legacy !== 'missing') await createSessionVault({ directory, safeStorage: storage }).save({
    access_token: 'fake-legacy-access', refresh_token: 'fake-legacy-refresh', clientId: deviceClientId,
    expiresAt: legacy === 'expired' ? 0 : now + 3600000,
  });
  const servers: any[] = [], authorizations: URL[] = [], vaults: any[] = [];
  const http = { createServer: vi.fn((handler: any) => {
    const server = { handler, port: 0, closed: false,
      once: vi.fn(), listen: vi.fn((port: number, host: string, ready: () => void) => {
        expect(host).toBe('127.0.0.1'); server.port = port || 49890; ready();
      }), address: () => ({ port: server.port }), close: vi.fn(() => { server.closed = true; }), closeAllConnections: vi.fn(),
    };
    servers.push(server); return server;
  }) };
  const native = { request: vi.fn(async () => ({ id: 'fake-account' })), clear: vi.fn() };
  const guest = { readFresh: vi.fn(), seekOwnedPaused: vi.fn() };
  const pcmClient = { dispose: vi.fn() };
  const media = () => ({ clear: vi.fn(), close: vi.fn(), add: vi.fn(), addGrowing: vi.fn() });
  const fetcher = vi.fn(async (url: string, init?: any): Promise<any> => {
    if (url === 'https://accounts.spotify.com/oauth2/device/authorize') return reply({ device_code: 'fake-device-code',
      verification_uri_complete: 'https://accounts.spotify.com/pair?code=fake-pair-code', expires_in: 600, interval: 5 });
    if (url === 'https://accounts.spotify.com/api/token') {
      if (init.body.get('grant_type') === 'refresh_token') return reply({ error: 'invalid_grant' }, 400);
      if (init.body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') return reply({
        access_token: 'fake-device-access', refresh_token: 'fake-device-refresh', expires_in: 3600 });
      return reply(tokenReply);
    }
    if (url === 'https://api.spotify.com/v1/me') return reply({ id: 'fake-account', display_name: 'Fake Account' });
    throw new Error('Unexpected fake request route');
  });
  const { createSpotifyService } = loadModule('service.cjs', {
    './catalogLogin.cjs': loadModule('catalogLogin.cjs', { 'node:http': http }),
    './sessionVault.cjs': { createSessionVault: (options: any) => {
      const vault = createSessionVault(options); vi.spyOn(vault, 'token'); vaults.push(vault); return vault;
    } },
    './nativeHost.cjs': { createNativeHost: () => native },
    './audioPreparation.cjs': { createAudioPreparation: (options: any) => createAudioPreparation({ ...options, media: media() }) },
    './soloistAudioPreparation.cjs': { createSoloistAudioPreparation: (options: any) => createSoloistAudioPreparation({ ...options, media: media() }) },
  });
  const openAuthorization = vi.fn(async (url: string) => { authorizations.push(new URL(url)); });
  const service = createSpotifyService({ directory, safeStorage: storage, fetcher, renderQr: async () => 'fake-qr-image',
    catalogClientId: clientId, openAuthorization,
    nativeExecutable: nativeEnabled ? '/fake/never-executed.exe' : undefined,
    ownedSoloist: soloist ? guest : undefined, soloistPcmClient: pcm ? pcmClient : undefined,
  });
  cleanups.push(() => service.close());
  const authorization = () => authorizations.at(-1)!;
  async function callback({ state, host, path, method = 'GET', server = servers.at(-1), url = authorization() }:
    { state?: string; host?: string; path?: string; method?: string; server?: any; url?: URL } = {}) {
    const target = new URL(url.searchParams.get('redirect_uri')!);
    target.searchParams.set('state', state ?? url.searchParams.get('state')!); target.searchParams.set('code', 'fake-catalog-code');
    const response = { statusCode: 200, headers: {} as Record<string, string>, body: '',
      setHeader(name: string, value: string) { this.headers[name] = value; },
      writeHead(status: number, headers?: Record<string, string>) { this.statusCode = status; Object.assign(this.headers, headers); return this; },
      end(value = '') { this.body = value; return this; },
    };
    await server.handler({ method, url: path ?? target.pathname + target.search, headers: { host: host ?? target.host } }, response);
    return response;
  }
  return { service, fetcher, native, guest, pcmClient, vaults, servers, authorization, openAuthorization, callback,
    catalogDirectory, legacyFile, advance: (ms: number) => { now += ms; } };
}

describe('Spotify Soloist catalog login through the actual service', () => {
  it.each(['missing', 'expired', 'unreadable'] as const)('logs in and checks status without the %s legacy playback vault', async legacy => {
    const f = await fixture({ legacy });
    expect(await f.service.request({ action: 'status' })).toBeNull();
    const key = await f.service.request({ action: 'loginBegin', deviceRequired: true });
    expect(key).toMatch(/^[a-f0-9-]{36}$/); expect(f.authorization().pathname).toBe('/authorize');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.vaults[0].token).not.toHaveBeenCalled();
    expect(await f.service.request({ action: 'loginImage', key })).toBe('fake-qr-image');
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'waiting' });
    const result = await f.callback(); expect(result.statusCode).toBe(303);
    expect(result.headers.Location).not.toContain(key);
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'confirmed' });
    expect(await f.service.request({ action: 'loginImage', key })).toBe('');
    expect(await f.service.request({ action: 'status' })).toEqual({ id: 'fake-account', display_name: 'Fake Account' });
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual(['https://accounts.spotify.com/api/token', 'https://api.spotify.com/v1/me']);
    expect(f.vaults[0].token).not.toHaveBeenCalled(); expect(f.native.request).not.toHaveBeenCalled();
    expect(f.guest.readFresh).not.toHaveBeenCalled(); expect(f.openAuthorization).toHaveBeenCalledOnce();
    await f.service.request({ action: 'logout' });
    expect(await f.service.request({ action: 'status' })).toBeNull();
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'expired' });
    await expect(readFile(f.legacyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.catalogDirectory, 'session.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.servers[0].close).toHaveBeenCalled(); expect(f.native.clear).toHaveBeenCalled();
  });

  it('keeps PKCE, callback state and host checks, and only records scopes actually granted', async () => {
    const f = await fixture(), key = await f.service.request({ action: 'loginBegin' });
    expect(f.authorization().searchParams.get('scope')!.split(' ').sort()).toEqual([
      'playlist-read-collaborative', 'playlist-read-private', 'user-library-read', 'user-modify-playback-state', 'user-read-playback-state', 'user-read-private',
    ]);
    expect((await f.callback({ state: 'wrong-state' })).statusCode).toBe(400);
    expect((await f.callback({ host: 'foreign.example:8989' })).statusCode).toBe(404);
    expect((await f.callback({ method: 'POST' })).statusCode).toBe(404);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.callback()).statusCode).toBe(303);
    const options = f.fetcher.mock.calls[0][1];
    expect(options.body.get('grant_type')).toBe('authorization_code'); expect(options.body.has('client_secret')).toBe(false);
    expect(options.body.get('client_id')).toBe(clientId);
    expect(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url')).toBe(f.authorization().searchParams.get('code_challenge'));
    expect((await f.service.readCatalogGrantedScopes()).scopes).toEqual(['user-read-private']);
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'confirmed' });
  });

  it.each([{ label: 'unknown', scope: undefined }, { label: 'malformed', scope: [] }])('preserves $label grant scope handling', async ({ scope }) => {
    const f = await fixture({ tokenReply: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600,
      ...(scope === undefined ? {} : { scope }) } });
    const key = await f.service.request({ action: 'loginBegin' });
    expect((await f.callback()).statusCode).toBe(scope === undefined ? 303 : 400);
    expect((await f.service.readCatalogGrantedScopes()).scopes).toBeNull();
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: scope === undefined ? 'confirmed' : 'error' });
  });

  it('cancels or replaces catalog consent without accepting its old callback', async () => {
    const f = await fixture(), first = await f.service.request({ action: 'loginBegin' });
    const oldServer = f.servers[0], oldUrl = f.authorization();
    const second = await f.service.request({ action: 'loginBegin' });
    expect(second).not.toBe(first); expect(oldServer.close).toHaveBeenCalled();
    expect(await f.service.request({ action: 'loginCheck', key: first })).toEqual({ state: 'expired' });
    expect((await f.callback({ server: oldServer, url: oldUrl })).statusCode).toBe(400);
    await f.service.request({ action: 'loginCancel', key: second });
    expect(await f.service.request({ action: 'loginCheck', key: second })).toEqual({ state: 'expired' });
    expect(await f.service.request({ action: 'loginImage', key: second })).toBe('');
    expect((await f.callback()).statusCode).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not save a delayed catalog exchange after logout', async () => {
    const f = await fixture(), key = await f.service.request({ action: 'loginBegin' });
    expect(f.authorization().pathname).toBe('/authorize');
    let resolve!: (value: unknown) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(complete => { resolve = complete; }));
    const pending = f.callback(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const signal = f.fetcher.mock.calls[0][1].signal;
    await f.service.request({ action: 'logout' }); expect(signal.aborted).toBe(true);
    resolve(reply({ access_token: 'fake-late-access', refresh_token: 'fake-late-refresh', expires_in: 3600 }));
    expect((await pending).statusCode).toBe(400);
    expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'expired' });
    expect(await f.service.request({ action: 'status' })).toBeNull();
    await expect(readFile(join(f.catalogDirectory, 'session.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Spotify legacy service login remains device then catalog', () => {
  it('routes saved tracks through the public catalog even when a legacy native host exists', async () => {
    const f = await fixture({ legacy: 'valid', soloist: false, tokenReply: {
      access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: 'user-library-read',
    } });
    await f.service.request({ action: 'loginBegin' });
    expect((await f.callback()).statusCode).toBe(303);
    f.fetcher.mockImplementationOnce(async url => {
      expect(url).toBe('https://api.spotify.com/v1/me/tracks?limit=50&offset=50');
      return reply({ items: [], total: 60, next: null });
    });
    expect(await f.service.request({ action: 'savedTracks', limit: 50, offset: 50 })).toEqual({ items: [], total: 60, next: null });
    expect(f.native.request).not.toHaveBeenCalled();
  });

  it.each([{ soloist: false, pcm: false }, { soloist: true, pcm: false }, { soloist: false, pcm: true }])(
    'keeps device consent unless the trusted Soloist audio composition exists: %j', async configuration => {
      const f = await fixture(configuration);
      const key = await f.service.request({ action: 'loginBegin', deviceRequired: false, soloistAudio: true });
      expect(f.authorization().pathname).toBe('/pair'); expect(f.vaults[0].token).toHaveBeenCalledOnce();
      expect(f.servers).toHaveLength(0); f.advance(5000);
      expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'waiting' });
      expect(f.authorization().pathname).toBe('/authorize'); expect(f.openAuthorization).toHaveBeenCalledTimes(2);
      expect((await f.callback()).statusCode).toBe(303);
      expect(await f.service.request({ action: 'loginCheck', key })).toEqual({ state: 'confirmed' });
      expect(await f.service.request({ action: 'status' })).toMatchObject({ id: 'fake-account' });
      expect(f.native.request).toHaveBeenCalledWith({ action: 'status' });
    });
  it('reuses an existing legacy playback grant without device consent', async () => {
    const f = await fixture({ legacy: 'valid', soloist: false });
    await f.service.request({ action: 'loginBegin' });
    expect(f.authorization().pathname).toBe('/authorize'); expect(f.vaults[0].token).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
