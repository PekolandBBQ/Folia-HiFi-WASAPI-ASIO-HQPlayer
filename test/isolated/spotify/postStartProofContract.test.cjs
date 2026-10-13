'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCableCaptureHost } = require('../../../electron/spotify/cableCaptureHost.cjs');
const { START_PROOF_CAPABILITY, QUEUE_BYTES, requireSnapshot } = require('../../../electron/spotify/cableCaptureProtocol.cjs');
const capabilities = ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1'];
function hostFixture(includeProof) {
  const calls = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); return true; };
  child.stdin = new Writable({ write(bytes, _, callback) {
    const request = JSON.parse(bytes.toString()); calls.push(request.action); callback();
    const result = request.action === 'hello' ? { protocolMajor: 1, platform: 'win32-x64', sampleRate: 44100,
      channels: 2, bitDepth: 32, sampleFormat: 's32le', queueCapacityBytes: QUEUE_BYTES,
      capabilities: [...capabilities, ...(includeProof ? [START_PROOF_CAPABILITY] : [])] } : { endpoints: [] };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n'));
  } });
  return { calls, host: createCableCaptureHost({ helperPath: 'C:\\Folia\\folia-capture.exe', platform: 'win32', spawnImpl: () => child }) };
}
function fixture() {
  const format = { sampleRate: 44100, channels: 2, containerBits: 32 };
  const selection = { captureDeviceId: 'capture', renderDeviceId: 'render', outputDeviceId: 'physical' };
  const record = { session: '12345678-1234-1234-1234-123456789abc', generation: 1, pipeName: 'folia-capture-test', selection };
  const value = { session: record.session, generation: 1, pipeName: record.pipeName, state: 'running', sampleRate: 44100,
    channels: 2, bitDepth: 32, sampleFormat: 's32le', sampleRateConversion: false, actualMixFormat: format,
    pipeConnected: true, startValidated: true, queueCapacityBytes: QUEUE_BYTES,
    configuration: { ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2,
      preparedFormat: 's32le', sampleRateConversion: false,
      capture: { id: 'capture', flow: 'capture', supportedBaseCable: true, mixFormat: format },
      render: { id: 'render', flow: 'render', supportedBaseCable: true, mixFormat: format },
      route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } } };
  return { record, value };
}
test('old helper lacking post-Start capability is rejected during hello before any device/open command', async () => {
  const f = hostFixture(false);
  await assert.rejects(f.host.devices(), { code: 'CAPTURE_PROTOCOL_INVALID' });
  assert.deepEqual(f.calls, ['hello']); await f.host.close();
});
test('helper with required post-Start capability passes hello', async () => {
  const f = hostFixture(true); assert.deepEqual(await f.host.devices(), { endpoints: [] });
  assert.deepEqual(f.calls, ['hello', 'devices']); await f.host.close();
});
for (const proof of [undefined, false, 1, 'true', null]) test(`running receipt rejects invalid post-Start proof ${String(proof)}`, () => {
  const { record, value } = fixture(); value.startValidated = proof;
  assert.throws(() => requireSnapshot(value, record, 'running'), { code: 'CAPTURE_PROTOCOL_INVALID' });
});
test('same-generation truthful running receipt is accepted', () => {
  const { record, value } = fixture(); assert.equal(requireSnapshot(value, record, 'running'), value);
});
test('proof on a foreign generation cannot validate current capture', () => {
  const { record, value } = fixture(); value.generation++;
  assert.throws(() => requireSnapshot(value, record, 'running'), { code: 'CAPTURE_PROTOCOL_INVALID' });
});
test('proof flag does not bypass strict 44.1 render/capture configuration', () => {
  const { record, value } = fixture(); value.configuration.render = { ...value.configuration.render, mixFormat: { sampleRate: 48000, channels: 2, containerBits: 32 } };
  assert.throws(() => requireSnapshot(value, record, 'running'), { code: 'CAPTURE_PROTOCOL_INVALID' });
});
test('prepared receipt is allowed before Start proof', () => {
  const { record, value } = fixture(); Object.assign(value, { state: 'prepared', startValidated: false, pipeConnected: false });
  assert.equal(requireSnapshot(value, record, 'prepared'), value);
});
