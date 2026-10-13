'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Focused r25 mismatch fields only; existing lifecycle regressions are intentionally not repeated.
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
function fixture(t, { holdStop = false, diagnosticThrows = false, terminalReceipt = false, receiptPatch = {}, createHost = createCableCaptureHost } = {}) {
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
  const host = createHost({ helperPath: '/synthetic/folia-capture.exe', platform: 'win32',
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

const descriptor = { sampleRate: 44100, channels: 2, containerBits: 32, validBits: 32, blockAlign: 8,
  averageBytesPerSecond: 352800, encoding: 'float', channelMask: 3, subFormatKind: 'float' };
const mismatch = 'FORMAT_LEASE_READBACK_MISMATCH';
function readback(patch = {}) {
  return { endpointRole: 'render', comparison: 'descriptor', periodFrames: 441,
    requested: { ...descriptor }, observed: { ...descriptor, channelMask: 0 }, differingFields: ['channelMask'], ...patch };
}
async function stopWithReadback(t, evidence, { errorCode = mismatch, receiptPatch = {}, ...options } = {}) {
  const f = fixture(t, { terminalReceipt: true, receiptPatch: { formatLeaseReadback: evidence, ...receiptPatch }, ...options });
  const source = await f.open(); await source.start();
  if (errorCode != null) f.nativeFailureWithoutEvent(errorCode);
  if (errorCode != null) f.sockets[0].emit('end');
  await source.stopVerified();
  return { ...f, source, terminal: f.projected.find(row => row.phase === 'native-terminal') };
}

test('r25 preserves the exact render descriptor mismatch through host, reporter and record projection', async t => {
  const evidence = readback(); const f = await stopWithReadback(t, evidence);
  assert.deepEqual(f.terminal.formatLeaseReadback, evidence);
  const record = schema.projectRecord({ timestamp: '2026-10-09T13:30:32.579Z', sequence: 217,
    runId: '96330dd5-6db1-4187-823b-c6d38d93715a', buildRef: 'a'.repeat(64), type: 'spotify.capture', fields: f.terminal });
  assert.deepEqual(record.fields.formatLeaseReadback, evidence);
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
  assert.equal(f.calls.filter(row => row.action === 'capture-stop').length, 1);
  assert.equal(f.calls.some(row => row.action === 'status' || row.action === 'inspect-route'), false);
});

test('r25 captures the capture-side rate/channels comparison and every bounded format field', async t => {
  const evidence = readback({ endpointRole: 'capture', comparison: 'rate-or-channels', periodFrames: 480,
    observed: { ...descriptor, sampleRate: 48000, averageBytesPerSecond: 384000 },
    differingFields: ['sampleRate', 'averageBytesPerSecond'] });
  const f = await stopWithReadback(t, evidence);
  assert.deepEqual(f.terminal.formatLeaseReadback, evidence);
});

test('r25 keeps original subtype difference evidence when both redacted subtype kinds are other', async t => {
  const evidence = readback({ requested: { ...descriptor, subFormatKind: 'other' },
    observed: { ...descriptor, subFormatKind: 'other' }, differingFields: ['subFormatKind'] });
  const f = await stopWithReadback(t, evidence);
  assert.deepEqual(f.terminal.formatLeaseReadback, evidence);
});

test('r25 descriptor numeric evidence retains signed32 and uint32 bounds without asserting format validity', async t => {
  const evidence = readback({ periodFrames: 4294967295,
    requested: { ...descriptor, sampleRate: -2147483648, channels: 2147483647, containerBits: -1, validBits: 0,
      blockAlign: -2147483648, averageBytesPerSecond: 2147483647, encoding: 'unsupported', channelMask: 4294967295, subFormatKind: 'none' },
    observed: { ...descriptor, encoding: 'pcm', subFormatKind: 'pcm' },
    differingFields: ['sampleRate', 'channels', 'containerBits', 'validBits', 'blockAlign', 'averageBytesPerSecond', 'encoding', 'channelMask', 'subFormatKind'] });
  const f = await stopWithReadback(t, evidence); assert.deepEqual(f.terminal.formatLeaseReadback, evidence);
});

const invalidEvidence = [
  { endpointRole: 'PRIVATE_DEVICE_ID' }, { comparison: 'PRIVATE_COMPARISON' }, { periodFrames: -1 }, { periodFrames: 4294967296 },
  { requested: { ...descriptor, sampleRate: 2147483648 } }, { observed: { ...descriptor, blockAlign: -2147483649 } },
  { observed: { ...descriptor, validBits: 0.5 } }, { observed: { ...descriptor, channels: '2' } },
  { observed: { ...descriptor, channelMask: -1 } }, { observed: { ...descriptor, channelMask: 4294967296 } },
  { observed: { ...descriptor, encoding: 'PRIVATE_ENCODING' } }, { requested: { ...descriptor, subFormatKind: 'PRIVATE_GUID' } },
  { observed: null }, { requested: {} }, { differingFields: [] }, { differingFields: ['PRIVATE_FIELD'] },
  { differingFields: ['channelMask', 'channelMask'] }, { differingFields: ['channelMask', 'sampleRate'] },
  { differingFields: new Array(10).fill('sampleRate') }, { differingFields: { length: 1, 0: 'channelMask' } },
];
for (let index = 0; index < invalidEvidence.length; index++) {
  test('r25 drops malformed readback payload while keeping terminal failure #' + (index + 1), async t => {
    const f = await stopWithReadback(t, readback(invalidEvidence[index]));
    assert.equal(Object.hasOwn(f.terminal, 'formatLeaseReadback'), false);
    assert.equal(f.terminal.errorCode, mismatch); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
    assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_/);
  });
}

test('r25 strips extra strings, raw subtype, paths and identities from fresh immutable projection copies', async t => {
  const evidence = readback({ path: 'PRIVATE_PATH', endpointId: 'PRIVATE_ENDPOINT',
    requested: { ...descriptor, subFormat: 'PRIVATE_GUID', token: 'PRIVATE_TOKEN' },
    observed: { ...descriptor, channelMask: 0, message: 'PRIVATE_EXCEPTION' } });
  const f = await stopWithReadback(t, evidence); const projected = f.terminal.formatLeaseReadback;
  assert.deepEqual(projected, readback());
  assert.equal(Object.isFrozen(projected), true); assert.equal(Object.isFrozen(projected.requested), true);
  assert.equal(Object.isFrozen(projected.observed), true); assert.equal(Object.isFrozen(projected.differingFields), true);
  assert.notEqual(projected, evidence); assert.notEqual(projected.requested, evidence.requested);
  evidence.requested.sampleRate = 123; evidence.differingFields[0] = 'PRIVATE_FIELD';
  assert.equal(projected.requested.sampleRate, 44100); assert.deepEqual(projected.differingFields, ['channelMask']);
  assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_/);
});

test('r25 never invokes descriptor or differing-field accessors', () => {
  let invoked = 0;
  const evidence = readback(); Object.defineProperty(evidence.observed, 'sampleRate', { get() { invoked++; return 48000; } });
  assert.equal(schema.projectFormatLeaseReadback(evidence), undefined);
  const fields = ['channelMask']; Object.defineProperty(fields, '0', { get() { invoked++; return 'channelMask'; } });
  assert.equal(schema.projectFormatLeaseReadback(readback({ differingFields: fields })), undefined);
  assert.equal(invoked, 0);
});

test('r25 ignores readback on another error, normal close, and legacy receipt without the new field', async t => {
  for (const errorCode of ['CAPTURE_DEVICE_FAILED', null]) {
    const f = await stopWithReadback(t, readback(), { errorCode });
    assert.equal(Object.hasOwn(f.terminal, 'formatLeaseReadback'), false);
  }
  const legacy = await stopWithReadback(t, undefined);
  assert.equal(legacy.terminal.errorCode, mismatch); assert.equal(Object.hasOwn(legacy.terminal, 'formatLeaseReadback'), false);
});

test('r25 rejects readback attached outside a fully matched native terminal envelope', async t => {
  for (const receiptPatch of [{ session: 'foreign' }, { generation: 2 }, { snapshotSource: 'command-reply' }, { state: 'running' }]) {
    const f = await stopWithReadback(t, readback(), { receiptPatch });
    assert.equal(f.projected.some(row => Object.hasOwn(row, 'formatLeaseReadback')), false);
  }
  const f = fixture(t); const source = await f.open(); await source.start();
  f.nativeError(source.generation + 1, mismatch, { terminalEvidence: f.terminal(source.generation + 1, {
    state: 'failed', errorCode: mismatch, formatLeaseReadback: readback(),
  }) });
  assert.equal(f.projected.some(row => Object.hasOwn(row, 'formatLeaseReadback')), false); assert.deepEqual(f.failures, []);
});

test('r25 late readback stays bound to retired generation and cannot overwrite first terminal evidence', async t => {
  const f = fixture(t); const first = await f.open(); await first.start(); f.sockets[0].emit('end'); await first.stopVerified();
  const second = await f.open(); await second.start();
  const terminalEvidence = f.terminal(first.generation, { state: 'failed', errorCode: mismatch, formatLeaseReadback: readback() });
  f.nativeError(first.generation, mismatch, { terminalEvidence });
  f.nativeError(first.generation, mismatch, { terminalEvidence: { ...terminalEvidence, formatLeaseReadback: readback({ endpointRole: 'capture' }) } });
  const rows = f.projected.filter(row => Object.hasOwn(row, 'formatLeaseReadback'));
  assert.equal(rows.length, 1); assert.equal(rows[0].generation, first.generation); assert.equal(rows[0].formatLeaseReadback.endpointRole, 'render');
  assert.equal(f.sockets[1].destroyed, false); assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']);
});

test('r25 schema independently suppresses readback on other phases, sources, states and errors', () => {
  const fields = { sessionRef: 3, generation: 1, phase: 'native-terminal', snapshotSource: 'native-terminal',
    captureState: 'failed', errorCode: mismatch, formatLeaseReadback: readback() };
  for (const patch of [{ phase: 'native-failed' }, { snapshotSource: 'cached-command-reply' }, { captureState: 'closed' }, { errorCode: 'CAPTURE_DEVICE_FAILED' }]) {
    assert.equal(Object.hasOwn(schema.projectEvent('spotify.capture', { ...fields, ...patch }).fields, 'formatLeaseReadback'), false);
  }
});

test('r25 optional projection failure cannot change stop acknowledgement or repeat failure callback', async t => {
  const filename = path.join(application, 'electron/spotify/cableCaptureHost.cjs');
  const cached = require.cache[filename], original = schema.projectFormatLeaseReadback; let createHost;
  try {
    schema.projectFormatLeaseReadback = () => { throw new Error('PRIVATE_PROJECTION_ERROR'); };
    delete require.cache[filename]; createHost = require(filename).createCableCaptureHost;
  } finally { schema.projectFormatLeaseReadback = original; require.cache[filename] = cached; }
  const f = await stopWithReadback(t, readback(), { createHost });
  assert.deepEqual(f.failures, ['CAPTURE_PIPE_CLOSED']); assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.calls.filter(row => row.action === 'capture-stop').length, 1);
  assert.doesNotMatch(JSON.stringify(f.projected), /PRIVATE_/);
});

