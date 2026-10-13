'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Synthetic native protocol orderings against the real host; no Windows, device, service or dependencies.
const application = path.resolve(process.env.FOLIA_CANDIDATE_ROOT || path.join(__dirname, '../../..'));
const { createCableCaptureHost } = require(path.join(application, 'electron/spotify/cableCaptureHost.cjs'));
const schema = require(path.join(application, 'electron/debug/privatePreviewDiagnosticSchema.cjs'));
const session = '12345678-1234-1234-1234-123456789abc';
const selection = { captureDeviceId: 'capture-private', renderDeviceId: 'render-private', outputDeviceId: 'output-private' };
const bootstrap = { ...selection, bootstrapMode: 'paused-source', bootstrapDelivery: 'discard',
  expectedSpotifyProcessId: 1234, expectedSpotifyStartedAtUnixMs: 1700000000000,
  expectedSpotifyStartTimeUtcTicks: '638355968000000000' };
const turn = () => new Promise(resolve => setImmediate(resolve));

// The fixture exposes independent PCM EOF and control-event delivery to reproduce the production race.
function fixture(t, { holdStop = false, diagnosticThrows = false, terminalReceipt = false, receiptPatch = {} } = {}) {
  const calls = [], sockets = [], diagnostics = [], projected = [], failures = [], pendingStops = [];
  const reporting = { exports: {} };
  const dependencies = {
    '../debug/privatePreviewDiagnosticSchema.cjs': schema,
    '../debug/privatePreviewDiagnosticBus.cjs': { isPreviewDiagnosticsEnabled: () => true, previewSessionRef: () => 3,
      publishPreviewDiagnostic: (type, fields) => { const row = schema.projectEvent(type, fields); if (row) projected.push(row.fields); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(application, 'electron/spotify/cableDiagnostics.cjs'), 'utf8'), {
    module: reporting, require: name => { assert(Object.hasOwn(dependencies, name)); return dependencies[name]; },
  });
  let active, nativeFault = null;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); return true; };
  const reply = (request, result) => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
  function snapshot(state) {
    const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
    const cold = !!active.bootstrapMode;
    const config = { ready: !cold, issues: cold ? ['SPOTIFY_ROUTE_NOT_FOUND'] : [], bootstrapReady: cold,
      selectedSampleRate: 44100, selectedChannels: 2, preparedFormat: 's32le', sampleRateConversion: false,
      capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat: format },
      render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat: format },
      route: { ready: !cold, spotifyOnlyObserved: !cold, spotifySessionPresent: !cold } };
    return { session: active.session, generation: active.generation, pipeName: active.pipeName, state,
      sampleRate: 44100, channels: 2, bitDepth: 32, sampleFormat: 's32le', sampleRateConversion: false,
      actualMixFormat: format, queueCapacityBytes: 705600, configuration: config, pipeConnected: state === 'running', startValidated: state === 'running',
      spotifyProcess: { processId: 1234, startedAtUnixMs: 1700000000000, startedAtUtcTicks: bootstrap.expectedSpotifyStartTimeUtcTicks },
      capturedFrames: 0, deliveredFrames: 0, queuedBytes: 0, initialDiscontinuity: false,
      ...(cold ? { bootstrapMode: 'paused-source', bootstrapDelivery: 'discard', deliveryState: 'discarding' } : {}) };
  }
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    const request = JSON.parse(bytes); calls.push(request); done();
    queueMicrotask(() => {
      if (request.action === 'hello') reply(request, { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100,
        channels: 2, bitDepth: 32, sampleFormat: 's32le', queueCapacityBytes: 705600,
        capabilities: ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', 'post-start-route-proof-v1', 'paused-source-bootstrap-v1'] });
      else if (request.action === 'capture-open') { active = request; reply(request, snapshot('prepared')); }
      else if (request.action === 'capture-start' || request.action === 'status') reply(request, snapshot('running'));
      else if (request.action === 'capture-stop') {
        const stop = () => reply(request, { session: request.session, generation: request.generation, state: 'closed',
          ...(terminalReceipt ? { terminalEvidence: terminal(request.generation, { ...receiptPatch }) } : {}) });
        if (holdStop) pendingStops.push(stop); else stop();
      } else assert.fail('Unexpected command: ' + request.action);
    });
  } });
  const host = createCableCaptureHost({ helperPath: '/synthetic/folia-capture.exe', platform: 'win32',
    spawnImpl: () => child,
    connectImpl: () => {
      const socket = new EventEmitter(); socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
      sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
    },
    onDiagnostic: row => {
      if (diagnosticThrows) throw new Error('PRIVATE_DIAGNOSTIC_ERROR');
      diagnostics.push(row);
      reporting.exports.reportCableCapture(row);
    },
  });
  t.after(() => host.close());
  function terminal(generation, patch = {}) {
    return { session, generation, state: nativeFault ? 'failed' : 'closed', errorCode: nativeFault,
      capturedFrames: 234, deliveredFrames: 0, queuedBytes: 0, snapshotSource: 'native-terminal', cleanupConfirmed: true,
      bootstrapMode: 'paused-source', bootstrapDelivery: 'discard', deliveryState: 'closed', ...patch };
  }
  return { host, child, calls, sockets, diagnostics, projected, failures,
    open: fields => host.open({ session, ...selection, ...fields, onFailure: error => failures.push(error.code) }),
    nativeError: (generation, errorCode = 'CAPTURE_DEVICE_FAILED', extra = {}) => child.stdout.write(JSON.stringify({
      event: 'capture-error', session, generation, errorCode, ...extra }) + '\n'),
    nativeFailureWithoutEvent: errorCode => { nativeFault = errorCode; }, terminal,
    releaseStops: () => pendingStops.splice(0).forEach(stop => stop()),
  };
}

test('pipe-first revokes immediately, retains late native cause, and never repeats onFailure', async t => {
  const f = fixture(t, { holdStop: true }); const source = await f.open(); await source.start();
  const waiting = source.stream[Symbol.asyncIterator]().next(); const rejected = assert.rejects(waiting, { code: 'CAPTURE_PIPE_CLOSED' });
  f.sockets[0].emit('end');
  assert.equal(f.sockets[0].destroyed, true); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  assert.equal(f.calls.filter(row => row.action === 'capture-stop').length, 1);
  await rejected;
  f.nativeError(source.generation);
  assert.deepEqual(f.diagnostics.filter(row => row.phase === 'native-failed').map(row => row.errorCode), ['CAPTURE_DEVICE_FAILED']);
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  await turn(); f.releaseStops(); await source.stopVerified();
});

test('native-first retains native cause and keeps one failure callback when EOF follows', async t => {
  const f = fixture(t); const source = await f.open(); await source.start();
  f.nativeError(source.generation); f.sockets[0].emit('end');
  assert.deepEqual(f.failures, ['CAPTURE_DEVICE_FAILED']);
  assert.equal(f.diagnostics.filter(row => row.phase === 'native-failed').length, 1);
  await source.stopVerified();
});

test('late native event after stop acknowledgment remains tied to its exact generation', async t => {
  const f = fixture(t); const source = await f.open(); await source.start();
  f.sockets[0].emit('close'); await source.stopVerified(); f.nativeError(source.generation, 'CAPTURE_FORMAT_CHANGED');
  const row = f.diagnostics.find(row => row.phase === 'native-failed');
  assert.equal(row.errorCode, 'CAPTURE_FORMAT_CHANGED'); assert.equal(row.generation, source.generation);
  assert.equal(Object.hasOwn(row, 'capturedFrames'), false); assert.equal(Object.hasOwn(row, 'snapshotSource'), false);
});

test('a retired generation can report evidence without failing or consuming replacement PCM', async t => {
  const f = fixture(t); const first = await f.open(); await first.start(); f.sockets[0].emit('end'); await first.stopVerified();
  const second = await f.open(); await second.start(); f.nativeError(first.generation, 'CAPTURE_OVERFLOW');
  assert.equal(f.sockets[1].destroyed, false); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  const read = second.stream[Symbol.asyncIterator]().next(); f.sockets[1].emit('data', Buffer.alloc(8, 7));
  assert.deepEqual((await read).value, Buffer.alloc(8, 7));
  assert.equal(f.diagnostics.find(row => row.phase === 'native-failed').generation, first.generation);
});

test('unbound session/generation and duplicate native events cannot create or multiply evidence', async t => {
  const f = fixture(t); const source = await f.open(); await source.start();
  f.nativeError(source.generation + 1); f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', { session: 'foreign-session' });
  assert.equal(f.diagnostics.filter(row => row.phase === 'native-failed').length, 0); assert.deepEqual(f.failures, []);
  f.nativeError(source.generation); f.nativeError(source.generation);
  assert.equal(f.diagnostics.filter(row => row.phase === 'native-failed').length, 1); assert.equal(f.failures.length, 1);
});

test('old child events cannot affect another host even with matching session and generation', async t => {
  const old = fixture(t); const first = await old.open(); await first.start(); await old.host.close();
  const current = fixture(t); const next = await current.open(); await next.start(); old.nativeError(first.generation);
  assert.deepEqual(current.failures, []); assert.equal(current.diagnostics.some(row => row.phase === 'native-failed'), false);
  assert.equal(current.sockets[0].destroyed, false);
});

test('cancel closes immediately without manufacturing a native fault or a pipe failure', async t => {
  const f = fixture(t); const abort = new AbortController(); const source = await f.open({ signal: abort.signal }); await source.start();
  const waiting = source.stream[Symbol.asyncIterator]().next(); const rejected = assert.rejects(waiting, { code: 'CANCELLED' }); abort.abort();
  await rejected; assert.deepEqual(f.failures, []); assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.diagnostics.some(row => row.phase === 'native-failed' || row.errorCode === 'CAPTURE_PIPE_CLOSED'), false);
});

test('stop-before-native-Tick loss remains explicitly unknown when helper emits no terminal evidence', async t => {
  // Models the native branch that clears current in capture-stop, then drops queued failures in DrainFailures.
  const f = fixture(t); const source = await f.open(); await source.start();
  f.sockets[0].emit('end'); await source.stopVerified();
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  assert.equal(f.diagnostics.some(row => row.phase === 'native-failed'), false);
  assert.equal(f.diagnostics.some(row => row.errorCode === 'CAPTURE_DEVICE_FAILED'), false);
});

test('paired native stop receipt retains a cause even when stop beats native Tick', async t => {
  const f = fixture(t, { terminalReceipt: true }); const source = await f.open(bootstrap); await source.start();
  f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED'); f.sockets[0].emit('end'); await source.stopVerified();
  const row = f.projected.find(value => value.phase === 'native-terminal');
  assert.deepEqual(row, { sessionRef: 3, errorCode: 'CAPTURE_DEVICE_FAILED', phase: 'native-terminal',
    snapshotSource: 'native-terminal', captureState: 'failed', cleanupConfirmed: true, bootstrapMode: 'paused-source',
    bootstrapDelivery: 'discard', deliveryState: 'closed', generation: 1, capturedFrames: 234, deliveredFrames: 0, queuedBytes: 0 });
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  assert.equal(f.projected.find(value => value.phase === 'failed').capturedFrames, 0);
  assert.equal(f.calls.some(value => value.action === 'status'), false);
});

test('normal native stop receipt is terminal evidence and never manufactures a failure', async t => {
  const f = fixture(t, { terminalReceipt: true }); const source = await f.open(); await source.start(); await source.stopVerified();
  const row = f.projected.find(value => value.phase === 'native-terminal');
  assert.equal(row.captureState, 'closed'); assert.equal(row.cleanupConfirmed, true); assert.equal(Object.hasOwn(row, 'errorCode'), false);
  assert.deepEqual(f.failures, []);
});

test('native event terminal receipt is preserved once and cleanup uncertainty stays explicit', async t => {
  const f = fixture(t, { terminalReceipt: true }); const source = await f.open(); await source.start();
  f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
  f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', { terminalEvidence: f.terminal(source.generation, { cleanupConfirmed: false }) });
  await source.stopVerified();
  assert.equal(f.projected.filter(value => value.phase === 'native-terminal').length, 1);
  assert.equal(f.projected.find(value => value.phase === 'native-terminal').cleanupConfirmed, false);
  assert.deepEqual(f.failures, ['CAPTURE_DEVICE_FAILED']);
});

for (const failureStage of ['initialize', 'start', 'read', 'stop', 'pipe']) {
  test('native terminal receipt preserves bounded fault detail from stage ' + failureStage, async t => {
    const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult: -2004287484, failureStage } });
    const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
    f.sockets[0].emit('end'); await source.stopVerified();
    const row = f.projected.find(value => value.phase === 'native-terminal');
    assert.equal(row.hresult, -2004287484); assert.equal(row.failureStage, failureStage);
    assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']); assert.equal(f.sockets[0].destroyed, true);
  });
}

for (const hresult of [-2147483648, -1, 0, 2147483647]) {
  test('native terminal HRESULT accepts signed32 boundary ' + hresult, async t => {
    const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult, failureStage: 'read' } });
    const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
    f.sockets[0].emit('end'); await source.stopVerified();
    assert.equal(f.projected.find(value => value.phase === 'native-terminal').hresult, hresult);
  });
}

for (const hresult of [-2147483649, 2147483648, 4294967295, 0.5, 'PRIVATE_HRESULT', null, { message: 'PRIVATE_HRESULT' }]) {
  test('invalid optional HRESULT is omitted without losing terminal cause: ' + JSON.stringify(hresult), async t => {
    const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult, failureStage: 'read' } });
    const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
    f.sockets[0].emit('end'); await source.stopVerified();
    const row = f.projected.find(value => value.phase === 'native-terminal');
    assert.equal(Object.hasOwn(row, 'hresult'), false); assert.equal(row.errorCode, 'CAPTURE_DEVICE_FAILED');
    assert.equal(row.failureStage, 'read'); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
    assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_/);
  });
}

for (const failureStage of ['PRIVATE_PATH', 'capture-read', 'READ', null, { message: 'PRIVATE_STAGE' }]) {
  test('unrecognized optional failure stage never escapes projection: ' + JSON.stringify(failureStage), async t => {
    const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult: -1, failureStage } });
    const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
    f.sockets[0].emit('end'); await source.stopVerified();
    const row = f.projected.find(value => value.phase === 'native-terminal');
    assert.equal(Object.hasOwn(row, 'failureStage'), false); assert.equal(row.hresult, -1);
    assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_/);
  });
}

test('later stop receipt and duplicate event cannot overwrite the first native fault detail', async t => {
  const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult: -2, failureStage: 'stop' } });
  const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
  f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', {
    terminalEvidence: f.terminal(source.generation, { hresult: -2004287484, failureStage: 'read' }),
  });
  await source.stopVerified();
  f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', {
    terminalEvidence: f.terminal(source.generation, { hresult: -3, failureStage: 'pipe' }),
  });
  const rows = f.projected.filter(value => value.phase === 'native-terminal');
  assert.equal(rows.length, 1); assert.equal(rows[0].hresult, -2004287484); assert.equal(rows[0].failureStage, 'read');
  assert.deepEqual(f.failures, ['CAPTURE_DEVICE_FAILED']);
});

test('normal terminal close and unbound raw events cannot introduce native fault details', async t => {
  const f = fixture(t, { terminalReceipt: true, receiptPatch: { hresult: -1, failureStage: 'stop' } });
  const source = await f.open(); await source.start(); await source.stopVerified();
  f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', { hresult: -2, failureStage: 'read' });
  assert.equal(f.projected.some(value => Object.hasOwn(value, 'hresult') || Object.hasOwn(value, 'failureStage')), false);
  assert.deepEqual(f.failures, []);
});

test('foreign nested identity cannot inject HRESULT or stage into a valid generation', async t => {
  const f = fixture(t); const source = await f.open(); await source.start(); f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED');
  f.nativeError(source.generation, 'CAPTURE_DEVICE_FAILED', {
    terminalEvidence: f.terminal(source.generation, { session: 'foreign', hresult: -1, failureStage: 'read' }),
  });
  await source.stopVerified();
  assert.equal(f.projected.some(value => value.phase === 'native-terminal'), false);
  assert.equal(f.projected.some(value => Object.hasOwn(value, 'hresult') || Object.hasOwn(value, 'failureStage')), false);
});

test('late known old-generation fault details stay on that generation and cannot fail replacement', async t => {
  const f = fixture(t); const first = await f.open(); await first.start(); f.sockets[0].emit('end'); await first.stopVerified();
  const next = await f.open(); await next.start();
  f.nativeError(first.generation, 'CAPTURE_DEVICE_FAILED', { terminalEvidence: f.terminal(first.generation, {
    state: 'failed', errorCode: 'CAPTURE_DEVICE_FAILED', hresult: -1, failureStage: 'read',
  }) });
  const row = f.projected.find(value => value.phase === 'native-terminal');
  assert.equal(row.generation, first.generation); assert.equal(row.hresult, -1); assert.equal(row.failureStage, 'read');
  assert.equal(f.sockets.at(-1).destroyed, false); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
});

test('an older native helper terminal receipt without optional details stays compatible', async t => {
  const f = fixture(t, { terminalReceipt: true }); const source = await f.open(); await source.start();
  f.nativeFailureWithoutEvent('CAPTURE_DEVICE_FAILED'); f.sockets[0].emit('end'); await source.stopVerified();
  const row = f.projected.find(value => value.phase === 'native-terminal');
  assert.equal(row.errorCode, 'CAPTURE_DEVICE_FAILED'); assert.equal(Object.hasOwn(row, 'hresult'), false);
  assert.equal(Object.hasOwn(row, 'failureStage'), false); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
});

for (const receiptPatch of [{ session: 'foreign' }, { generation: 2 }, { capturedFrames: -1 }, { capturedFrames: 2 ** 43 },
  { deliveredFrames: '234' }, { queuedBytes: 705608 }, { snapshotSource: 'cached-command-reply' }, { state: 'running' },
  { cleanupConfirmed: 'true' }, { state: 'failed', errorCode: null }]) {
  test('invalid native receipt cannot contaminate evidence or veto valid stop: ' + JSON.stringify(receiptPatch), async t => {
    const f = fixture(t, { terminalReceipt: true, receiptPatch }); const source = await f.open(); await source.start(); await source.stopVerified();
    assert.equal(f.projected.some(value => value.phase === 'native-terminal'), false); assert.deepEqual(f.failures, []);
  });
}

test('paused source absence is accepted without closing or publishing PCM', async t => {
  const f = fixture(t); const source = await f.open(bootstrap); await source.start(); await turn();
  assert.equal(source.snapshot().configuration.ready, false); assert.deepEqual(f.failures, []);
  assert.equal(f.sockets[0].destroyed, false); assert.equal(source.receivedFrames(), 0);
  await assert.rejects(source.promote(), { code: 'CAPTURE_PROTOCOL_INVALID' });
});

test('failure frame counts are explicitly cached, while native event makes no frame readback claim', async t => {
  const f = fixture(t); const source = await f.open(); await source.start(); f.sockets[0].emit('end'); f.nativeError(source.generation);
  const running = f.projected.find(row => row.phase === 'running'); const failed = f.projected.find(row => row.phase === 'failed');
  const native = f.projected.find(row => row.phase === 'native-failed');
  assert.equal(running.snapshotSource, 'command-reply'); assert.equal(failed.snapshotSource, 'cached-command-reply');
  assert.equal(failed.capturedFrames, 0); assert.equal(native.errorCode, 'CAPTURE_DEVICE_FAILED');
  assert.equal(Object.hasOwn(native, 'capturedFrames'), false); assert.equal(Object.hasOwn(native, 'snapshotSource'), false);
});

test('native diagnostic projection permits only fixed phase, code and identity references', async t => {
  const f = fixture(t); const source = await f.open(); await source.start();
  f.nativeError(source.generation, 'PRIVATE_ERROR_TEXT', { message: 'PRIVATE_EXCEPTION', capturedFrames: 234,
    hresult: 'PRIVATE_HRESULT', path: 'PRIVATE_PATH', configuration: { secret: 'PRIVATE_SECRET' } });
  const native = f.projected.find(row => row.phase === 'native-failed');
  assert.deepEqual(native, { sessionRef: 3, errorCode: 'CAPTURE_REQUEST_FAILED', phase: 'native-failed', generation: 1 });
  assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_|capture-private|render-private|output-private|folia-capture-/);
});

test('bounded terminal records forget only sufficiently old generations and never stop current output', async t => {
  const f = fixture(t); let source;
  for (let i = 0; i < 18; i++) { source = await f.open(); await source.start(); if (i < 17) await source.stopVerified(); }
  f.nativeError(1); assert.equal(f.diagnostics.some(row => row.phase === 'native-failed'), false);
  f.nativeError(17); assert.equal(f.diagnostics.filter(row => row.phase === 'native-failed').length, 1);
  assert.deepEqual(f.failures, []); assert.equal(f.sockets.at(-1).destroyed, false);
});

test('observer errors cannot prevent immediate stop or cause a second failure callback', async t => {
  const f = fixture(t, { diagnosticThrows: true }); const source = await f.open(); await source.start();
  f.sockets[0].emit('end'); f.nativeError(source.generation); await source.stopVerified();
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']); assert.equal(f.sockets[0].destroyed, true);
});
