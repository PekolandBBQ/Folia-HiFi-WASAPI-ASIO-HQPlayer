'use strict';
// Set before any package module loads its process-wide logger/test mode.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.QQ_DISABLE_UPDATE_CHECK = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createAuthenticatedQqSearch, installQqAuthenticatedSearch } = require('../../../electron/qqAuthenticatedSearch.cjs');

// test/unit/electron/qqAuthenticatedSearch.node.test.cjs: exercise the installed QQ host with synthetic credentials and loopback HTTP.
const mainRoot = path.resolve(__dirname, '../../..');
const mainRequire = createRequire(path.join(mainRoot, 'package.json'));
const manifestPath = mainRequire.resolve('@yakult-green-tea/qq-music-api/package.json');
const packageRoot = path.dirname(manifestPath);
const protocol = require(path.join(packageRoot, 'dist/src/services/auth/qrLogin.js'));
const android = require(path.join(packageRoot, 'dist/src/services/auth/androidDevice.js'));
const fixture = () => ({
  token: 'test-opaque-session', expiresAt: Date.now() + 60000,
  credential: { musicid: 0, str_musicid: '123456789', musickey: 'TEST_KEY_123', loginType: 2 },
  device: { display: 'test', product: 'test', device: 'test', board: 'test', model: 'test',
    fingerprint: 'test', procVersion: 'test', imei: '123456789012345', brand: 'test',
    androidId: 'TEST_AID', openUdid: 'TEST_UDID', osRelease: '10', sdk: 29 },
});
const SONG = { id: 1531817, mid: '003MUDkf30pS5B', title: '幻听', interval: 272,
  singer: [{ id: 5062, mid: '000CK5xN3yZDJt', name: '许嵩', musickey: 'SHOULD_NOT_ESCAPE' }],
  album: { id: 123, mid: '00TestAlbum', name: 'test', token: 'SHOULD_NOT_ESCAPE' },
  file: { media_mid: '00TestMedia', secretUrl: 'SHOULD_NOT_ESCAPE' },
  authst: 'SHOULD_NOT_ESCAPE', nested: { secret: 'SHOULD_NOT_ESCAPE' } };
const response = (songs = [SONG]) => ({ status: 200, data: { code: 0, req_0: {
  code: 0, data: { code: 0, body: { item_song: songs }, meta: { nextpage: -1, sum: songs.length } },
} } });
function setup(post = async () => response()) {
  let auth = fixture();
  const calls = [];
  const service = { authFor: async token => token === auth?.token ? auth : null,
    http: { post: async (...args) => { calls.push(args); return post(...args); } } };
  return { calls, service, replace: value => { auth = value; },
    search: createAuthenticatedQqSearch({ service, buildAndroidComm: protocol.buildAndroidComm,
      credentialMusicId: android.credentialMusicId, isAuthSession: protocol.isAuthSession, searchId: () => '1234567890123' }) };
}
test('uses real pinned Android comm and session credential only in one main-only Mobile request', async () => {
  const host = setup();
  const result = await host.search({ query: '幻听', limit: 20, page: 2 }, 'test-opaque-session');
  assert.equal(host.calls.length, 1);
  const [url, body, config] = host.calls[0];
  assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
  assert.equal(body.comm.qq, '123456789'); assert.equal(body.comm.authst, 'TEST_KEY_123');
  assert.equal(body.comm.tmeLoginType, 2); assert.equal(body.comm.tmeAppID, 'qqmusic');
  assert.equal(body.req_0.method, 'DoSearchForQQMusicMobile');
  assert.deepEqual(body.req_0.param, { searchid: '1234567890123', query: '幻听', search_type: 0,
    num_per_page: 20, page_num: 2, highlight: true, grp: true, selectors: {}, vec_selectors: [] });
  assert.equal(config.headers.Cookie, 'uin=123456789; qqmusic_uin=123456789; qm_keyst=TEST_KEY_123; qqmusic_key=TEST_KEY_123');
  assert.equal(result.data.songs[0].file.media_mid, '00TestMedia');
  assert.equal(result.data.hasMore, false);
  assert.doesNotMatch(JSON.stringify(result), /TEST_KEY|TEST_UDID|123456789|SHOULD_NOT_ESCAPE|authst/);
});
test('missing, wrong or expired session is rejected before any upstream request', async () => {
  const host = setup();
  for (const token of [undefined, '', 'other-user']) {
    await assert.rejects(host.search({ query: '幻听' }, token), { code: 'QQ_SEARCH_AUTH_REQUIRED', status: 401 });
  }
  host.replace({ ...fixture(), expiresAt: Date.now() - 1 });
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session'), { status: 401 });
  assert.equal(host.calls.length, 0);
});
test('logout during an in-flight response does not publish results from a revoked session', async () => {
  let release;
  const host = setup(() => new Promise(resolve => { release = resolve; }));
  const pending = host.search({ query: '幻听' }, 'test-opaque-session');
  await new Promise(resolve => setImmediate(resolve)); host.replace(null); release(response());
  await assert.rejects(pending, { status: 401 }); assert.equal(host.calls.length, 1);
});
test('credential replacement for the same token does not publish another session results', async () => {
  const host = setup(async () => { host.replace({ ...fixture(), credential: { ...fixture().credential, str_musicid: '987654321' } }); return response(); });
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session'), { status: 401 });
});
test('real upstream branch 2001 stays a controlled rejection, never empty success or anonymous fallback', async () => {
  const host = setup(async () => ({ status: 200, data: { code: 0, req_0: { code: 2001, data: { body: { item_song: [] }, message: 'PRIVATE_KEY' } } } }));
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session'), { code: 'QQ_SEARCH_UPSTREAM_REJECTED', upstreamCode: 2001, status: 502 });
  assert.equal(host.calls.length, 1);
});
test('missing result schema is an error while an explicit accepted empty page succeeds', async () => {
  const host = setup(async () => ({ status: 200, data: { code: 0, req_0: { code: 0, data: {} } } }));
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session'), { code: 'QQ_SEARCH_INVALID_RESPONSE' });
  const empty = await setup(async () => response([])).search({ query: '幻听' }, 'test-opaque-session');
  assert.deepEqual(empty.data.songs, []);
});
test('network rejection never includes Axios config, credentials, full URL, raw cause or stack in public error fields', async () => {
  const host = setup(async () => { throw Object.assign(new Error('TEST_KEY_123 private URL'), { config: { headers: { Cookie: 'TEST_KEY_123' } } }); });
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session'), failure => {
    assert.equal(failure.code, 'QQ_SEARCH_NETWORK_FAILURE');
    assert.doesNotMatch(JSON.stringify(failure), /TEST_KEY|Cookie|https|config|cause/); return true;
  });
});
test('invalid parameters and cancellation before dispatch cannot request upstream', async () => {
  const host = setup();
  for (const input of [{ query: '' }, { query: 'x', limit: 101 }, { query: 'x', page: 0 }, { query: 'x', limit: '2junk' }, { query: 'x\r\n' }, { query: ['x'] }]) {
    await assert.rejects(host.search(input, 'test-opaque-session'), { status: 400 });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session', { signal: controller.signal }), { status: 499 });
  assert.equal(host.calls.length, 0);
});
test('cancellation after dispatch never publishes a late page', async () => {
  const controller = new AbortController();
  const host = setup(async () => { controller.abort(); return response(); });
  await assert.rejects(host.search({ query: '幻听' }, 'test-opaque-session', { signal: controller.signal }), { status: 499 });
});

test('simultaneous users keep each request bound to its own resolved credential despite reversed response order', async () => {
  const first = fixture();
  const second = { ...fixture(), token: 'second-test-session', credential: { ...fixture().credential, str_musicid: '987654321', musickey: 'SECOND_TEST_KEY' } };
  let releaseFirst;
  const service = { authFor: async token => token === first.token ? first : token === second.token ? second : null,
    http: { post: async (_url, body) => {
      if (body.comm.qq === '123456789') await new Promise(resolve => { releaseFirst = resolve; });
      return response([{ ...SONG, title: body.comm.qq === '123456789' ? 'first-public-track' : 'second-public-track' }]);
    } } };
  const search = createAuthenticatedQqSearch({ service, buildAndroidComm: protocol.buildAndroidComm,
    credentialMusicId: android.credentialMusicId, isAuthSession: protocol.isAuthSession });
  const pendingFirst = search({ query: 'x' }, first.token);
  await new Promise(resolve => setImmediate(resolve));
  const resultSecond = await search({ query: 'x' }, second.token);
  releaseFirst(); const resultFirst = await pendingFirst;
  assert.equal(resultSecond.data.songs[0].title, 'second-public-track');
  assert.equal(resultFirst.data.songs[0].title, 'first-public-track');
});

test('a fixed-version mismatch keeps the older host untouched for explicit route capability fallback', () => {
  let installations = 0, reads = 0;
  const installed = installQqAuthenticatedSearch({ default: { use: () => { installations++; } } }, {
    packageJsonPath: path.join(__dirname, 'not-read-real-manifest.json'),
    loadModule: () => { reads++; return { version: '3.1.1' }; },
  });
  assert.equal(installed, false); assert.equal(installations, 0); assert.equal(reads, 1);
});

test('actual package Koa host + real singleton session repository + login token parser serve the installed route over HTTP', async () => {
  // All identifiers are synthetic. Only local HTTP is real; the upstream post is replaced.
  const api = mainRequire('@yakult-green-tea/qq-music-api');
  assert.equal(api.server, null);
  const authModule = require(path.join(packageRoot, 'dist/src/services/auth/qrLogin.node.js'));
  const service = authModule.qrLoginService;
  const originalHttp = service.http;
  const auth = fixture();
  api.configureAuthSessionRepository(protocol.createMemoryAuthSessionRepository([auth]));
  let upstreamCalls = 0, sentCredential = false;
  service.http = { post: async (_url, body, config) => { upstreamCalls++; sentCredential = body.comm.authst === 'TEST_KEY_123' && config.headers.Cookie.includes('qqmusic_key=TEST_KEY_123'); return response(); } };
  // app.listen() captures the official package middleware chain before host registration.
  const server = api.default.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    assert.equal(installQqAuthenticatedSearch(api, { packageJsonPath: manifestPath }), true);
    const base = `http://127.0.0.1:${server.address().port}`;
    const searchResponse = await fetch(`${base}/user/search?query=${encodeURIComponent('幻听')}&limit=20&page=1`, { headers: { 'X-QQ-Session': auth.token } });
    assert.equal(searchResponse.status, 200); assert.equal(searchResponse.headers.get('cache-control'), 'no-store');
    const body = await searchResponse.json(); assert.equal(body.data.songs[0].id, 1531817);
    assert.doesNotMatch(JSON.stringify(body), /TEST_KEY|TEST_UDID|SHOULD_NOT_ESCAPE|authst/);
    assert.equal(upstreamCalls, 1); assert.equal(sentCredential, true);
    const querySession = await fetch(`${base}/user/search?query=x&cookie=${encodeURIComponent(`qqmusic_session=${auth.token}`)}`);
    assert.equal(querySession.status, 200); assert.equal(upstreamCalls, 2);
    const cookieSession = await fetch(`${base}/user/search?query=x`, { headers: { Cookie: `qqmusic_session=${auth.token}` } });
    assert.equal(cookieSession.status, 200); assert.equal(upstreamCalls, 3);
    const missing = await fetch(`${base}/user/search?query=x`); assert.equal(missing.status, 401); assert.equal(upstreamCalls, 3);
    const unsupportedMethod = await fetch(`${base}/user/search`, { method: 'POST' }); assert.equal(unsupportedMethod.status, 405); assert.equal(upstreamCalls, 3);
    const legacy = await fetch(`${base}/login/status`); assert.equal(legacy.status, 200);
    const logout = await fetch(`${base}/logout`, { headers: { 'X-QQ-Session': auth.token } }); assert.equal(logout.status, 200);
    const revoked = await fetch(`${base}/user/search?query=x`, { headers: { 'X-QQ-Session': auth.token } }); assert.equal(revoked.status, 401); assert.equal(upstreamCalls, 3);
  } finally {
    service.http = originalHttp;
    api.configureAuthSessionRepository(protocol.createMemoryAuthSessionRepository());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
