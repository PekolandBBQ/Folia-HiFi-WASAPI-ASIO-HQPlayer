'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { createSoloistAudioPreparation } = require('../../electron/spotify/soloistAudioPreparation.cjs');
const { createSoloistApplianceComposition } = require('../../electron/spotify/soloistApplianceComposition.cjs');
const { createApplicationSoloist } = require('../../electron/spotify/soloistApplication.cjs');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const { createCatalogObservation } = require('../../electron/spotify/catalogObservation.cjs');
const { reportSpotifyHttp, reportSpotifyScopes, reportSpotifyPreparationFailure } = require('../../electron/spotify/requestDiagnostics.cjs');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { projectEvent } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');

// Actual host modules with synthetic account, transport and runtime boundaries; never contact a service.
const id = 'A'.repeat(22), requestId = '12345678-1234-1234-1234-123456789abc';
const stamp = { epoch: 0, revision: 0 };
const vault = { token: async () => 'PRIVATE_SYNTHETIC_TOKEN', stamp: () => stamp,
  grantedScopes: async () => ({ ...stamp, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
const cooldown = { load: async () => 0, defer: async () => 0 };
const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() };
const forbidden = label => () => { throw new Error('Unexpected test side effect: ' + label); };
function observations(t) {
  const events = [];
  const detach = installPreviewDiagnosticSink({ enabled: () => true, record: (type, fields) => { events.push({ type, fields }); return true; } });
  t.after(detach); return events;
}
function emptyAppliance(t) {
  const composition = createSoloistApplianceComposition({ directory: '/synthetic-audit-only', safeStorage: storage,
    sshExecutablePath: '/synthetic-audit-only/ssh', sshExecutableSha256: '0'.repeat(64), ownerOptions: {},
    io: { lstat: async () => { throw Object.assign(new Error('Synthetic missing vault'), { code: 'ENOENT' }); } },
    createOwner: forbidden('owner'), createOwned: forbidden('owned-runtime'), downloadOfficialAsset: forbidden('download'),
    runGuestCommand: forbidden('guest'), secureRuntimeDirectory: forbidden('directory'), createDiscovery: null });
  t.after(() => composition.close()); return composition;
}
function audioFixture(t, { fetcher, applyQuality } = {}) {
  let httpCalls = 0;
  const audio = createSoloistAudioPreparation({ vault, cooldown, soloistApplyQuality: applyQuality,
    association: { acquirePlaybackTarget: async () => ({ deviceId: 'PRIVATE_SYNTHETIC_DEVICE', stamp, validUntil: Date.now() + 5000 }) },
    fetcher: async (...args) => { httpCalls++; return (fetcher || forbidden('Spotify HTTP'))(...args); },
    client: { prepare: forbidden('prepare PCM'), play: forbidden('play PCM'), pause: forbidden('pause PCM'), close: forbidden('close PCM') },
    media: { add: forbidden('publish audio'), close: async () => {} } });
  t.after(() => audio.close()); return { audio, httpCalls: () => httpCalls };
}
function loadService(overrides) {
  const file = path.resolve(__dirname, '../../electron/spotify/service.cjs'), realRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(file),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name), process,
    URL, URLSearchParams, AbortSignal, AbortController, Date, Buffer, setTimeout, clearTimeout }, { filename: file });
  return module.exports;
}

test('missing playback setup stays setup-required and does not make a Spotify request or start a runtime', async t => {
  const events = observations(t), composition = emptyAppliance(t);
  assert.equal((await composition.publicStatus()).state, 'unconfigured');
  const f = audioFixture(t, { applyQuality: composition.getSoloistConfiguration().applyQuality });
  await assert.rejects(f.audio.prepare(id, requestId), { code: 'setup-required', message: 'Spotify: playback-setup-required' });
  assert.equal(f.httpCalls(), 0);
  assert.deepEqual(events.filter(row => row.type === 'spotify.preparation').map(row => row.fields), [{
    sessionRef: 1, stage: 'quality-setup', errorCode: 'setup-required', causeCode: 'SOLOIST_KEY_REQUIRED',
  }]);
});

test('missing setup is checked before optional component validation on the first playback attempt', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'folia-setup-preflight-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const application = createApplicationSoloist({ app: { isPackaged: false, getPath: () => directory }, safeStorage: storage,
    environment: {}, createComposition: forbidden('component assembly') });
  t.after(() => application.close());
  assert.equal((await application.publicStatus()).state, 'unconfigured');
  await assert.rejects(async () => application.getSoloistConfiguration().applyQuality('high'), { code: 'SOLOIST_KEY_REQUIRED' });
  assert.equal((await application.publicStatus()).state, 'unconfigured');
});

test('an unconfigured playback receiver does not block catalog status or playlist browsing', async t => {
  const composition = emptyAppliance(t); let setupCalls = 0, httpCalls = 0;
  const { createSpotifyService } = loadService({
    './sessionVault.cjs': { createSessionVault: () => vault }, './cooldown.cjs': { createCooldown: () => cooldown },
    './soloistAudioPreparation.cjs': { createSoloistAudioPreparation: options => createSoloistAudioPreparation({ ...options,
      media: { add: forbidden('publish'), close: async () => {} } }) },
  });
  const service = createSpotifyService({ directory: '/synthetic-audit-only', safeStorage: storage,
    ownedSoloist: { readFresh: forbidden('receiver read'), seekOwnedPaused: forbidden('receiver seek') },
    soloistPcmClient: { dispose() {} }, soloistApplyQuality: (...args) => { setupCalls++; return composition.getSoloistConfiguration().applyQuality(...args); },
    fetcher: async url => { httpCalls++; return Response.json(url.endsWith('/me') ? { id: 'PRIVATE_SYNTHETIC_ACCOUNT' } : { items: [], total: 0, next: null }); } });
  t.after(() => service.close());
  assert.equal((await composition.publicStatus()).state, 'unconfigured');
  assert.equal((await service.request({ action: 'status' })).id, 'PRIVATE_SYNTHETIC_ACCOUNT');
  assert.deepEqual((await service.request({ action: 'playlists' })).items, []);
  assert.equal(setupCalls, 0); assert.equal(httpCalls, 2);
});

test('the registered renderer IPC preserves the new public setup-required code and only its safe message', async () => {
  const handlers = new Map(), sender = { isDestroyed: () => false, send() {} };
  const service = loadService({ electron: { safeStorage: {}, net: { fetch: forbidden('network') }, shell: { openExternal: forbidden('browser') } },
    qrcode: { toDataURL: forbidden('QR') }, './runtime.cjs': { createSpotifyRuntime: ({ createService }) => createService({}) } });
  const app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: () => '/synthetic-audit-only', quit() {} });
  service.registerSpotify({ app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, isTrustedSender: value => value === sender,
    soloistConfiguration: {}, createSoloist: () => ({ getServiceOptions: () => ({}), close: async () => {} }),
    createService: () => ({ request: async () => { throw Object.assign(new Error('Spotify: playback-setup-required'), {
      code: 'setup-required', privateCause: 'PRIVATE_CAUSE' }); }, close: async () => {} }) });
  const result = await handlers.get('spotify:request')({ sender }, { action: 'audio', id, requestId, quality: 'high' });
  assert.equal(result.spotifyError.code, 'setup-required');
  assert.equal(result.spotifyError.message, 'Spotify: playback-setup-required');
  assert.deepEqual(Object.keys(result.spotifyError).sort(), ['code', 'message']);
});

test('catalog diagnostics separate HTTP denial from bounded successful pagination without URL or identity data', async t => {
  const events = observations(t);
  let reject = true;
  const api = createSpotifyCatalog({ vault, cooldown, fetcher: async () => reject ? new Response('PRIVATE_RAW_BODY', { status: 403 })
    : Response.json({ items: [{ id: 'PRIVATE_TRACK' }, null], total: 102, next: 'https://private.invalid/next?token=PRIVATE_TOKEN' }) });
  await assert.rejects(api.request('playlistTracks', { id, offset: 50, limit: 50 }), { code: 'unsupported' });
  reject = false; await api.request('playlistTracks', { id, offset: 50, limit: 50 });
  assert.deepEqual(events.filter(row => row.type === 'spotify.http').map(row => row.fields), [
    { endpoint: 'catalog-playlist-items', method: 'GET', httpStatus: 403, playlistRef: 1, pageOffset: 50, pageLimit: 50 },
    { endpoint: 'catalog-playlist-items', method: 'GET', httpStatus: 200, playlistRef: 1, pageOffset: 50, pageLimit: 50,
      rawCount: 2, totalCount: 102, hasContinuation: true, pageShape: 'root', inspectedCount: 2,
      itemEnvelopeCount: 0, trackEnvelopeCount: 0, directItemCount: 2, nullItemCount: 1,
      localItemCount: 0, episodeItemCount: 0, invalidItemCount: 1, trackItemCount: 0, restrictedItemCount: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:|Authorization|AAAA/);
});

test('playback HTTP diagnostics distinguish track metadata from playback selection', async t => {
  const events = observations(t);
  for (const method of ['GET', 'PUT']) {
    const f = audioFixture(t, { fetcher: async (_url, init) => init.method === method ? new Response(null, { status: 403 })
      : Response.json({ id, type: 'track', uri: 'spotify:track:' + id, duration_ms: 120000 }) });
    await assert.rejects(f.audio.prepare(id, requestId), { code: 'unsupported', message: 'Spotify: playback-http-403' });
  }
  const failures = events.filter(row => row.type === 'spotify.http' && row.fields.httpStatus === 403);
  assert.deepEqual(failures.map(row => [row.fields.endpoint, row.fields.method]), [['playback-track', 'GET'], ['playback-select', 'PUT']]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:|AAAA/);
});

test('account/device observation diagnostics identify the rejected route without reading a failure body', async t => {
  const events = observations(t);
  for (const target of ['me', 'me/player/devices']) {
    const catalog = createCatalogObservation({ vault, cooldown, fetcher: async url => new URL(url).pathname === '/v1/' + target
      ? new Response('PRIVATE_RESPONSE_BODY', { status: 403 }) : Response.json({ id: 'PRIVATE_ACCOUNT' }) });
    await assert.rejects(catalog.readFresh({ devicesOnly: true }), { code: 'API_FORBIDDEN' });
  }
  assert.deepEqual(events.filter(row => row.type === 'spotify.http' && row.fields.httpStatus === 403).map(row => row.fields.endpoint),
    ['playback-profile', 'playback-devices']);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:/);
});

test('preparation diagnostics retain only a closed cause enum, never arbitrary error strings', async t => {
  const events = observations(t);
  for (const code of ['APPLIANCE_COMPONENT_UNAVAILABLE', 'PRIVATE_ARBITRARY_CODE']) {
    const f = audioFixture(t, { applyQuality: async () => { throw Object.assign(new Error('PRIVATE_RAW_ERROR_URL'), { code }); } });
    await assert.rejects(f.audio.prepare(id, requestId), { code: 'unavailable', message: 'Spotify: soloist-preparation-failed' });
  }
  assert.deepEqual(events.filter(row => row.type === 'spotify.preparation').map(row => row.fields.causeCode), ['APPLIANCE_COMPONENT_UNAVAILABLE', 'UNKNOWN']);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('scope diagnostics use the existing catalog vault read and reveal only requested presence booleans', async t => {
  const events = observations(t), directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'folia-scope-diagnostics-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const account = createSessionVault({ directory, safeStorage: { ...storage, decryptString: bytes => { reads++; return storage.decryptString(bytes); } },
    diagnosticScopes: true, fetcher: forbidden('token refresh') });
  await account.save({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', clientId: 'a'.repeat(32),
    expiresAt: Date.now() + 3600000, scope: 'playlist-read-private user-read-playback-state PRIVATE_EXTRA_SCOPE' });
  assert.equal(await account.token(), 'PRIVATE_ACCESS');
  assert.equal(reads, 1);
  assert.deepEqual(events.filter(row => row.type === 'spotify.scopes').map(row => row.fields), [{
    scopesKnown: true, playlistReadPrivate: true, playlistReadCollaborative: false, userLibraryRead: false, playbackRead: true, playbackModify: false,
  }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|access_token|refresh_token|clientId/);
});

test('diagnostic projections never call getters or stringify unknown scope and cause values', t => {
  const events = observations(t); let accesses = 0;
  const hostile = { toJSON() { accesses++; throw new Error('PRIVATE_JSON'); }, toString() { accesses++; throw new Error('PRIVATE_STRING'); } };
  for (const key of ['items', 'tracks', 'offset', 'limit', 'code']) Object.defineProperty(hostile, key, { get() { accesses++; throw new Error('PRIVATE_GETTER'); } });
  reportSpotifyHttp('catalog-search', 'GET', 200, hostile, hostile);
  reportSpotifyScopes(hostile);
  reportSpotifyPreparationFailure('PRIVATE_SESSION', 'association', hostile, hostile);
  assert.equal(accesses, 0);
  assert.deepEqual(events.map(row => row.fields), [
    { endpoint: 'catalog-search', method: 'GET', httpStatus: 200 },
    { scopesKnown: false },
    { sessionRef: 1, stage: 'association', errorCode: 'UNKNOWN', causeCode: 'UNKNOWN' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('diagnostic schemas reject unsafe categories and invalid numeric observations', () => {
  assert.equal(projectEvent('spotify.http', { endpoint: 'https://PRIVATE_URL', method: 'GET', httpStatus: 200 }), null);
  assert.equal(projectEvent('spotify.http', { endpoint: 'catalog-playlist-items', method: 'GET', httpStatus: 700 }), null);
  assert.deepEqual(projectEvent('spotify.http', { endpoint: 'catalog-playlist-items', method: 'GET', httpStatus: 200,
    pageOffset: -1, pageLimit: 500, rawCount: Infinity, totalCount: -1, hasContinuation: 'PRIVATE_VALUE', url: 'PRIVATE_URL' }), {
    type: 'spotify.http', fields: { endpoint: 'catalog-playlist-items', method: 'GET', httpStatus: 200 },
  });
  assert.equal(projectEvent('spotify.preparation', { stage: 'PRIVATE_STAGE', errorCode: 'unavailable' }), null);
});
