'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
// Independent production Host checks. The helper process is an explicit NDJSON fixture.
const app = '/workspace/scratch/d96e392874a5/folia-r36-performance/handoff/application/research/r36-paused-proof/application';
const { createOwnedRouteHost } = require(app + '/electron/spotify/ownedRouteHost.cjs');
const session = '12345678-1234-1234-1234-123456789abc', uri = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp';
function fixture(capability, sourceHandler) {
  const calls = [], observed = [], child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let handler;
  const reply = (input, value) => child.stdout.write(JSON.stringify({ id: input.id, ...value }) + '\n');
  child.stdin = new Writable({ write(bytes, _, done) {
    const input = JSON.parse(bytes); calls.push(input); done(); queueMicrotask(() => {
      if (handler?.(input)) return;
      if (input.command === 'sourceControlResult') return;
      if (input.command === 'hello') return reply(input, { ok: true, state: 'available', capabilities: {
        protocolMajor: 1, componentVersion: '0.19.0-dev.13', ownedSilentRenderLease: true, preparedSelection: true, boundedPreparationObservation: true, boundedRestoreObservation: true, platform: 'win32-x64', contract: 'folia-owned-route-v1', supported: true, productionQualified: true,
        heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true, retainedJournalRecovery: true,
        intervalIsolation: true, indefiniteHeldPause: true, freshResumeInterval: true, boundedPausedHoldObservation: capability, blockers: [],
        operations: ['hello', 'inspect', 'acquire', 'armCaptureInterval', 'authorizeResume', 'status', 'heartbeat', 'release', 'close', 'suspendPaused', 'resumePreparation', 'authorizePreparedSelection', 'completePreparedSelection'],
      } });
      reply(input, { ok: true, state: input.command === 'close' ? 'closed' : 'heldPaused', code: 'NO_POLICY_WRITES', noPolicyWrites: true });
      if (input.command === 'close') queueMicrotask(() => child.emit('exit', 0));
    });
  }, final(done) { done(); queueMicrotask(() => child.emit('exit', 0)); } });
  const host = createOwnedRouteHost({ componentDirectory: '/fixture', platform: 'win32', spawnImpl: () => child,
    resolveComponent: async () => '/fixture/never-run', timeoutMs: 500, exitTimeoutMs: 50,
    onSourceControl: async (...args) => { observed.push(args[0]); return sourceHandler?.(...args) || facts(args[0]); } });
  function emit(phase = true) { child.stdout.write(JSON.stringify({ event: 'sourceControl', requestId: 'source-12345678-1234-1234-1234-123456789abc',
    action: 'read', session, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri,
    ...(phase ? { requirePreparationObservation: true, preparationPhase: 'selected' } : {}) }) + '\n'); }
  return { host, calls, observed, emit, reply, handle: value => { handler = value; },
    async setup() { await host.request('acquire', { session, generation: 1, sourceDeviceId: 'desktop', expectedSourceUri: uri });
      await host.request('authorizePreparedSelection', { selectedSourceUri: uri }); await host.request('completePreparedSelection', {}); },
    close: () => host.close().catch(() => {}) };
}
function facts(input) { return { sourceDeviceId: 'desktop', trackUri: uri, isPlaying: false, observedAtUtc: new Date().toISOString(), pcmStopped: true,
  ...(input.requirePreparationObservation ? { preparationOwned: true, playbackRequestPending: false, observationGeneration: 8, mutationEpoch: 4, preparationPhase: 'selected', positionMs: 10 } : {}) }; }
async function until(check) { for (let n=0;n<100;n++) { if(check()) return; await delay(5); } throw new Error('No expected callback'); }
test('old helper capability refuses explicit reuse and preserves ordinary fresh suspend callback', async () => {
  const f = fixture(false); try {
    await f.setup(); await assert.rejects(f.host.request('suspendPaused', { reusePauseObservation: true }), { code: 'ROUTE_PROTOCOL_INVALID' });
    assert.equal(f.calls.filter(x=>x.command==='suspendPaused').length, 0);
    let suspend;
    f.handle(input => { if(input.command==='suspendPaused'){suspend=input;f.emit(false);return true;}
      if(input.command==='sourceControlResult'){f.reply(suspend,{ok:true,state:'pausedHeld'});return true;} });
    await f.host.request('suspendPaused', {});
    assert.equal(f.observed.length,1); assert.equal(f.observed[0].pauseObservationOnly,undefined); assert.equal(f.observed[0].pauseFreshFallback,undefined);
  } finally { await f.close(); }
});
test('reuse permission attaches only to an exact pending suspend transaction', async () => {
  const f = fixture(true); try {
    await f.setup(); let suspend;
    f.handle(input => { if(input.command==='suspendPaused'){suspend=input;f.emit();return true;}
      if(input.command==='sourceControlResult'){f.reply(suspend,{ok:true,state:'pausedHeld'});return true;} });
    await f.host.request('suspendPaused', { reusePauseObservation: true });
    assert.equal(f.observed.length,1); assert.equal(f.observed[0].pauseObservationOnly,true);
    assert.equal(f.observed[0].session,session); assert.equal(f.observed[0].generation,1);
    assert.equal(f.calls.find(x=>x.command==='sourceControlResult').payload.ok,true);
  } finally { await f.close(); }
});
test('a response finishing after native completes suspend cannot send late source authority', async () => {
  let finish; const gate=new Promise(resolve=>{finish=resolve;});
  const f = fixture(true, async input=>{await gate;return facts(input);}); try {
    await f.setup(); let suspend;
    f.handle(input=>{if(input.command==='suspendPaused'){suspend=input;f.emit();return true;}});
    const request=f.host.request('suspendPaused',{reusePauseObservation:true}); await until(()=>f.observed.length===1);
    f.reply(suspend,{ok:true,state:'pausedHeld'}); await request; finish(); await delay(15);
    assert.equal(f.calls.filter(x=>x.command==='sourceControlResult').length,0);
    await assert.rejects(f.host.request('status',{}));
  } finally { finish(); await f.close(); }
});
