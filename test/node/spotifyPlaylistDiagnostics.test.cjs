'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { observeSpotifyOperation } = require('../../electron/spotify/privatePreviewObserver.cjs');
const { reportSpotifyHttp } = require('../../electron/spotify/requestDiagnostics.cjs');
const { previewPlaylistRef, playlistResponseFields } = require('../../electron/spotify/playlistDiagnostics.cjs');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { projectEvent } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');

// test/node/spotifyPlaylistDiagnostics.test.cjs — synthetic responses only; observations never send requests.
const firstId = 'A'.repeat(22), secondId = 'B'.repeat(22);
const track = index => ({ id: String(index).padStart(22, '0'), name: 'PRIVATE_TRACK_NAME', type: 'track' });
const vault = { token: async () => 'PRIVATE_TOKEN' }, cooldown = { load: async () => 0 };
function observations(t) {
  const events = [], detach = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type, fields) => { events.push({ type, fields }); return true; } });
  t.after(detach); return events;
}

test('queued detail and item calls correlate to their own service operation and the same run-local playlist', async t => {
  const events = observations(t), calls = [];
  const api = createSpotifyCatalog({ vault, cooldown, fetcher: async url => {
    calls.push(url);
    if (url.includes(secondId)) return new Response('PRIVATE_FORBIDDEN_BODY', { status: 403 });
    const page = { items: [{ item: track(1) }, { item: track(2) }, { item: track(3) }], total: 3, next: null, offset: 0, limit: 50 };
    return Response.json(url.includes('/items?') ? page : { id: firstId, name: 'PRIVATE_PLAYLIST', items: page, collaborative: false });
  } });
  const request = input => observeSpotifyOperation('ipc', input, () => observeSpotifyOperation('service', input,
    context => api.request(input.action, input, context)));
  const results = await Promise.allSettled([
    request({ action: 'playlist', id: firstId }), request({ action: 'playlistTracks', id: firstId, limit: 50 }),
    request({ action: 'playlistTracks', id: secondId, limit: 50 }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(calls.length, 3);
  const http = events.filter(event => event.type === 'spotify.http');
  assert.equal(http.length, 3);
  assert.equal(http[0].fields.playlistRef, http[1].fields.playlistRef);
  assert.notEqual(http[1].fields.playlistRef, http[2].fields.playlistRef);
  for (const response of http) {
    const commands = events.filter(event => event.type === 'spotify.command'
      && event.fields.operationRef === response.fields.operationRef);
    assert.deepEqual(commands.map(event => event.fields.phase), ['request', 'result']);
    assert.ok(commands.every(event => event.fields.layer === 'service' && event.fields.playlistRef === response.fields.playlistRef));
  }
  assert.equal(http[0].fields.pageShape, 'items'); assert.equal(http[0].fields.collaborative, false);
  for (const event of http.slice(0, 2)) {
    assert.equal(event.fields.rawCount, 3); assert.equal(event.fields.totalCount, 3);
    assert.equal(event.fields.hasContinuation, false); assert.equal(event.fields.trackItemCount, 3);
    assert.equal(event.fields.responseOffset, 0); assert.equal(event.fields.responseLimit, 50);
  }
  assert.equal(http[2].fields.httpStatus, 403); assert.equal(http[2].fields.pageShape, undefined);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|AAAA|BBBB|https?:|ownerId|accountId/);
});

test('real service observer forwards the diagnostic context without adding account or HTTP calls', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
  const events = observations(t), file = require.resolve('../../electron/spotify/service.cjs');
  const realRequire = createRequire(file), module = { exports: {} }; let requests = 0, tokenReads = 0;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(file), process,
    require: name => name === './sessionVault.cjs' ? { createSessionVault: () => ({ token: async () => { tokenReads++; return 'PRIVATE_TOKEN'; } }) }
      : name === './cooldown.cjs' ? { createCooldown: () => cooldown } : realRequire(name),
    URL, URLSearchParams, AbortSignal, AbortController, Date, Buffer, setTimeout, clearTimeout }, { filename: file });
  const service = module.exports.createSpotifyService({ directory: '/synthetic-only', safeStorage: {}, fetcher: async () => {
    requests++; return Response.json({ items: [], total: 0, next: null });
  } });
  t.after(() => service.close());
  await service.request({ action: 'playlistTracks', id: firstId });
  const request = events.find(event => event.type === 'spotify.command' && event.fields.phase === 'request');
  const http = events.find(event => event.type === 'spotify.http');
  assert.equal(http.fields.operationRef, request.fields.operationRef);
  assert.equal(http.fields.playlistRef, request.fields.playlistRef);
  assert.equal(requests, 1); assert.equal(tokenReads, 1);
});

test('raw shape observations distinguish both envelopes, filtered rows and retained unavailable tracks', t => {
  observations(t);
  const page = { items: [{ item: track(1) }, { track: track(2) }, { ...track(3), is_playable: false }, { item: null },
    { track: { ...track(4), type: 'episode' } }, { item: { ...track(5), is_local: true } }, { item: { id: 'PRIVATE_INVALID' } }, null],
    total: 10, next: 'PRIVATE_NEXT_URL', offset: 0, limit: 50 };
  const fields = playlistResponseFields('catalog-playlist-items', page);
  assert.deepEqual(fields, { pageShape: 'root', totalCount: 10, hasContinuation: true, responseOffset: 0, responseLimit: 50,
    rawCount: 8, inspectedCount: 8, itemEnvelopeCount: 4, trackEnvelopeCount: 2, directItemCount: 2,
    nullItemCount: 2, localItemCount: 1, episodeItemCount: 1, invalidItemCount: 1, trackItemCount: 3, restrictedItemCount: 1 });
  assert.equal(playlistResponseFields('catalog-playlist', { tracks: page }).pageShape, 'tracks');
  assert.equal(playlistResponseFields('catalog-playlist', { name: 'PRIVATE_METADATA_ONLY' }).pageShape, 'missing');
});

test('playlist observation is bounded and does not invoke getters or serialize response metadata', t => {
  const events = observations(t); let accesses = 0;
  const hostile = { toJSON() { accesses++; throw new Error(); }, toString() { accesses++; throw new Error(); } };
  for (const key of ['items', 'tracks', 'id', 'name', 'item', 'track', 'is_local', 'type', 'next', 'collaborative'])
    Object.defineProperty(hostile, key, { get() { accesses++; throw new Error(); } });
  reportSpotifyHttp('catalog-playlist', 'GET', 200, undefined, hostile);
  const items = Array(51).fill({ item: track(1) });
  Object.defineProperty(items, '50', { get() { accesses++; throw new Error(); } });
  reportSpotifyHttp('catalog-playlist-items', 'GET', 200, undefined, { items, total: 51, next: null });
  reportSpotifyHttp('catalog-playlist-items', 'GET', 200, undefined, { items: [hostile], total: 1, next: null });
  assert.equal(accesses, 0);
  assert.equal(events[1].fields.rawCount, 51); assert.equal(events[1].fields.inspectedCount, 50);
  assert.equal(events[2].fields.invalidItemCount, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:|AAAA|BBBB/);
});

test('run-local references reset with the diagnostic sink and disabled observation does no work', () => {
  assert.equal(previewPlaylistRef(firstId), undefined);
  assert.deepEqual(playlistResponseFields('catalog-playlist', new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(); } })), {});
  for (let run = 0; run < 2; run++) {
    const detach = installPreviewDiagnosticSink({ enabled: () => true, record() {} });
    try { assert.equal(previewPlaylistRef(firstId), 1); assert.equal(previewPlaylistRef(secondId), 2); assert.equal(previewPlaylistRef(firstId), 1); }
    finally { detach(); }
  }
  assert.deepEqual(projectEvent('spotify.http', { endpoint: 'catalog-playlist', method: 'GET', httpStatus: 200,
    playlistRef: 'PRIVATE_ID', operationRef: -1, pageShape: 'PRIVATE_SHAPE', inspectedCount: 51, trackItemCount: Infinity,
    collaborative: 'PRIVATE_VALUE', owner: 'PRIVATE_OWNER', responseLimit: 100, responseOffset: -1 }).fields,
    { endpoint: 'catalog-playlist', method: 'GET', httpStatus: 200 });
});
