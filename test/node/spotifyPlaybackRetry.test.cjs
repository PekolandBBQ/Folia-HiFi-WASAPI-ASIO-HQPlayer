'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { retryPlayback, transient } = require('../../electron/spotify/playbackRetry.cjs');
const { failureDetails, descriptions } = require('../../electron/spotify/failureDetails.cjs');
const { publicError } = require('../../electron/spotify/cableAudioFacts.cjs');
const { createSpotifyRuntime } = require('../../electron/spotify/runtime.cjs');
const fault = code => Object.assign(new Error(code), { code });
const wait = async () => {};
test('every retryable failure has a concrete Chinese reason without its machine code', () => {
  for (const code of transient) {
    assert.ok(descriptions[code], code);
    const result = failureDetails(publicError(fault(code)), 'audio');
    assert.match(result.detail, /[\u4e00-\u9fff]/); assert.ok(!result.detail.includes(code), code);
    assert.equal(result.nativeCode, code);
  }
});
test('three retries means four attempts, with a fresh read every time and no nested retry multiplication', async () => {
  let attempts = 0; const reports = [];
  const action = () => { attempts++; throw fault('PLAYBACK_STATE_UNCONFIRMED'); };
  await assert.rejects(retryPlayback(() => retryPlayback(action, { wait }), { wait, report: v => reports.push(v) }), e => {
    assert.equal(e.retryCount, 3); assert.equal(e.retriesExhausted, true);
    assert.match(failureDetails(publicError(e), 'audio').detail, /三次/); return true;
  });
  assert.equal(attempts, 4); assert.equal(reports.filter(v => v.phase === 'retry').length, 0);
});
test('a third retry can recover and does not mark the next request as failed', async () => {
  let attempts = 0; const reports = [];
  assert.equal(await retryPlayback(() => { if (++attempts < 4) throw fault('CAPTURE_STOP_TIMEOUT'); return 'pcm'; }, { wait, report: v => reports.push(v) }), 'pcm');
  assert.equal(reports.at(-1).phase, 'recovered');
  assert.equal(await retryPlayback(() => 'next-track', { wait }), 'next-track');
});
test('cancellation, account/identity changes and rate limiting do not replay writes', async () => {
  for (const code of ['CANCELLED', 'SUPERSEDED', 'AUTH_REQUIRED', 'SESSION_CHANGED', 'RATE_LIMITED', 'EXTERNAL_POLICY_CONFLICT', 'SPOTIFY_INSTANCE_CHANGED']) {
    let calls = 0; await assert.rejects(retryPlayback(() => { calls++; throw fault(code); }, { wait }), { code }); assert.equal(calls, 1);
  }
});
async function runtimeFixture(t, request, retryWait = wait) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createSpotifyRuntime({ directory, environment: {}, connectionMode: 'wrapper', retryWait, onRetry: () => {},
    createService: () => ({ request, close: async () => {} }) });
}
test('actual runtime re-enters preparation after a cleanup fault and returns only the recovered result', async t => {
  let calls = 0;
  const runtime = await runtimeFixture(t, async () => { if (++calls <= 3) throw publicError(fault('ROUTE_SOURCE_PAUSE_UNCONFIRMED')); return 'fresh-pcm'; });
  assert.equal(await runtime.request({ action: 'audio', requestId: 'one' }), 'fresh-pcm'); assert.equal(calls, 4);
  assert.equal(await runtime.request({ action: 'audio', requestId: 'two' }), 'fresh-pcm'); assert.equal(calls, 5);
});
for (const action of ['cancelAudio', 'leaveProvider', 'close', 'audio', 'output']) test(`runtime ${action} cancels an old retry during backoff`, async t => {
  let release, entered; const waiting = new Promise(r => { entered = r; }); const attempts = [];
  const runtime = await runtimeFixture(t, async input => {
    if (input.action !== 'audio') return null;
    attempts.push(input.requestId); if (input.requestId === 'old') throw fault('PLAYBACK_STATE_UNCONFIRMED'); return 'new-pcm';
  }, async () => { entered(); await new Promise(r => { release = r; }); });
  const old = runtime.request({ action: 'audio', requestId: 'old' });
  const rejection = assert.rejects(old, { code: 'CANCELLED' }); await waiting;
  if (action === 'output') await runtime.prepareSourceOutput('another-source', 'hqplayer');
  else if (action === 'close') await runtime.close();
  else if (action === 'leaveProvider') await runtime.leaveProvider();
  else await runtime.request({ action, requestId: action === 'audio' ? 'new' : 'old' });
  release(); await rejection;
  assert.deepEqual(attempts, action === 'audio' ? ['old', 'new'] : ['old']);
});
test('unknown causes are not disguised as a connection failure or exposed as English codes', () => {
  const result = failureDetails(fault('NEW_UNKNOWN_FAILURE'), 'audio');
  assert.match(result.detail, /没有提供已识别的原因/); assert.doesNotMatch(result.detail, /NEW_UNKNOWN_FAILURE/);
});

test('a later user retry has a new budget even when a cleanup owner retains the same exception', async () => {
  const error = fault('CAPTURE_STOP_TIMEOUT'); let calls = 0;
  for (let request = 0; request < 2; request++)
    await assert.rejects(retryPlayback(() => { calls++; throw error; }, { wait }), { retriesExhausted: true });
  assert.equal(calls, 8);
});

test('all admitted route and capture codes have Chinese UI descriptions', () => {
  const fs = require('node:fs');
  const route = require('../../electron/spotify/ownedRouteProtocol.cjs').CODES;
  const source = fs.readFileSync(require.resolve('../../electron/spotify/cableCaptureProtocol.cjs'), 'utf8');
  const begin = source.indexOf('const CODES');
  const capture = [...source.slice(begin, source.indexOf(']);', begin)).matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(m => m[1]);
  for (const code of [...route, ...capture]) {
    assert.ok(descriptions[code], code);
    const detail = failureDetails({ code }, 'audio').detail;
    assert.ok(!detail.includes(code), code); assert.match(detail, /[\u4e00-\u9fff]/);
  }
});

test('cold identity failures retry preparation three times then recover', async t=>{
 let calls=0;const runtime=await runtimeFixture(t,async()=>{if(++calls<4)throw publicError(fault('BOOTSTRAP_IDENTITY_UNCONFIRMED'));return 'prepared';});
 assert.equal(await runtime.request({action:'audio',requestId:'cold'}),'prepared');assert.equal(calls,4);await runtime.close();
});
test('cold identity failure stops after three retries and preserves the real cause', async t=>{
 let calls=0;const runtime=await runtimeFixture(t,async()=>{calls++;throw Object.assign(publicError(fault('BOOTSTRAP_IDENTITY_UNCONFIRMED')),{failureCode:'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN'});});
 await assert.rejects(runtime.request({action:'audio',requestId:'cold'}),{failureCode:'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN',retryCount:3,retriesExhausted:true});assert.equal(calls,4);await runtime.close();
});
