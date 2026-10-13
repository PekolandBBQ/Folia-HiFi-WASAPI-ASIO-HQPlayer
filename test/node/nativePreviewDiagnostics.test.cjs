'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { installPreviewDiagnosticSink, publishPreviewDiagnostic, previewSessionRef } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { createPcmDiagnosticCounter } = require('../../electron/nativeAudio/livePcmSession.cjs');

// test/node/nativePreviewDiagnostics.test.cjs — pure JavaScript mocked output integration, no native executables/sockets.
function sink(t) {
    const events = [];
    const detach = installPreviewDiagnosticSink({ enabled: () => true, record(type, fields) { events.push({ type, fields }); return true; } });
    t.after(detach); return events;
}
function mockService(t, { immediateQuitDeadline = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-native-observation-'));
    const file = require.resolve('../../electron/nativeAudio/service.cjs');
    // Only this JavaScript service's platform branch is selected; every native dependency is injected.
    const scope = { module: { exports: {} }, require: createRequire(file), process: { platform: 'win32', arch: 'x64' },
        Buffer, URL, AbortController, setTimeout: (callback, ms) => setTimeout(callback, immediateQuitDeadline && ms === 2500 ? 0 : ms),
        clearTimeout, console: { info() {}, error() {} } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), scope, { filename: file });
    const app = Object.assign(new EventEmitter(), { getPath: () => directory });
    const sender = { mainFrame: {}, send() {}, isDestroyed: () => false };
    let onHelperEvent, position = 0, playing = false, failCommand = false;
    const state = () => ({ session: 'private-session', sampleRate: 96000, channels: 2, outputFormat: 'PCM32 integer direct',
        position, duration: 120, playing, ended: false, pipeName: 'private-pipe-name', deviceId: 'private-device' });
    const stream = { prepare: async () => state(), observe: () => true, close: async () => {},
        command: async action => { if (failCommand) throw Object.assign(new Error('private-error-token'), { code: 'DEVICE_UNAVAILABLE' });
            if (action === 'play') playing = true; if (action === 'pause') playing = false; return state(); } };
    const helper = { dispose() {}, request: async request => request.action === 'hello'
        ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry', 'streaming-pcm-v1'] }
        : request.action === 'devices' ? [{ id: 'private-device', name: 'Private Owner DAC', backend: 'asio' }] : state() };
    const service = scope.module.exports.registerNativeAudio({ app, ipcMain: { handle() {} }, isTrustedSender: value => value === sender,
        componentManager: { status: async () => ({ available: true, executable: 'private-helper-path' }) }, decoderResolver: async () => 'private-decoder-path',
        helperFactory: (_file, callback) => { onHelperEvent = callback; return helper; }, hqplayerFactory: () => ({ stop: async () => {}, dispose() {} }),
        resolveLivePcmSource: () => ({ sampleRate: 96000, channels: 2, durationMs: 120000 }), liveStreamFactory: () => stream });
    t.after(async () => { app.emit('before-quit'); await new Promise(resolve => setImmediate(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
    const request = input => service.handle({ sender, senderFrame: sender.mainFrame }, input);
    return { request, service, sender, app, event: state => onHelperEvent({ event: 'state', state }), state,
        fail: () => { failCommand = true; }, stallClose: () => { stream.close = () => new Promise(() => {}); } };
}
test('actual native service records command, state, progress and release while keeping original source depth unknown', async t => {
    const events = sink(t), f = mockService(t);
    await f.request({ action: 'begin', session: 'private-session', backend: 'asio', deviceId: 'private-device',
        url: 'http://127.0.0.1:12345/private-token', sourceName: 'private-title' });
    await f.request({ action: 'finish', session: 'private-session' });
    await f.request({ action: 'play', session: 'private-session' });
    f.event(f.state());
    const formats = events.filter(event => event.type === 'native.format' && event.fields.outputBitsPerSample === 32);
    assert.ok(formats.length > 0); assert.ok(formats.every(event => event.fields.sourceBitsPerSample === undefined));
    assert.equal(formats.at(-1).fields.sourceEncodingVerified, false); assert.equal(formats.at(-1).fields.preparedSource, true);
    await f.request({ action: 'stop', session: 'private-session' });
    assert.ok(events.some(event => event.type === 'native.progress' && event.fields.stage === 'buffer'));
    assert.ok(events.some(event => event.type === 'native.device' && event.fields.phase === 'opened'));
    assert.deepEqual(events.filter(event => event.type === 'native.release').map(event => event.fields.phase), ['request', 'release']);
    assert.equal(events.filter(event => event.type === 'native.release').at(-1).fields.releaseAcknowledged, true);
    const references = events.filter(event => event.fields.sessionRef !== undefined).map(event => event.fields.sessionRef);
    assert.equal(new Set(references).size, 1); assert.equal(typeof references[0], 'number');
    assert.doesNotMatch(JSON.stringify(events), /private-|127\.0\.0\.1|Private Owner/);
});
test('a bounded quit timeout records an unacknowledged release instead of asserting cleanup completed', async t => {
    const events = sink(t), f = mockService(t, { immediateQuitDeadline: true });
    await f.request({ action: 'begin', session: 'private-session', backend: 'asio', deviceId: 'private-device', url: 'http://127.0.0.1/private' });
    await f.request({ action: 'finish', session: 'private-session' }); f.stallClose();
    f.app.emit('before-quit', { preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 10));
    const released = events.filter(event => event.type === 'native.release').at(-1);
    assert.equal(released.fields.phase, 'release'); assert.equal(released.fields.reason, 'shutdown');
    assert.equal(released.fields.releaseAcknowledged, false); assert.equal(released.fields.ok, false);
});
test('native device enumeration and rejected commands preserve semantics while exposing only counts and codes', async t => {
    const events = sink(t), f = mockService(t);
    const devices = await f.request({ action: 'devices' }); assert.equal(devices[0].name, 'Private Owner DAC');
    assert.equal(events.find(event => event.type === 'native.device').fields.deviceCount, 1);
    await f.request({ action: 'begin', session: 'private-session', backend: 'asio', deviceId: 'private-device', url: 'http://127.0.0.1/private' });
    await f.request({ action: 'finish', session: 'private-session' }); f.fail();
    await assert.rejects(f.request({ action: 'play', session: 'private-session' }), error => error.message === 'private-error-token' && error.code === 'DEVICE_UNAVAILABLE');
    const failure = events.findLast(event => event.type === 'native.command');
    assert.equal(failure.fields.ok, false); assert.equal(failure.fields.errorCode, 'DEVICE_UNAVAILABLE');
    const count = events.length;
    await assert.rejects(f.service.handle({ sender: {}, senderFrame: {} }, { action: 'play', token: 'private' }));
    assert.equal(events.length, count); assert.doesNotMatch(JSON.stringify(events), /private-|Private Owner|127\.0\.0\.1/);
});
test('PCM observations count real signed samples at five-second intervals and flush final counts only', t => {
    const events = sink(t); let time = 0;
    const counter = createPcmDiagnosticCounter({ session: 'private-pcm-session', backend: 'asio', channels: 2, clock: () => time });
    const samples = Buffer.alloc(16); samples.writeInt32LE(-1, 4); samples.writeInt32LE(2147483647, 8);
    counter.observe(samples); assert.equal(events.length, 0);
    time = 4999; counter.observe(samples); assert.equal(events.length, 0);
    time = 5000; counter.observe(samples); assert.equal(events.length, 1);
    assert.deepEqual(events[0].fields, { sessionRef: 1, backend: 'asio', phase: 'sample', frames: 6, zeroSamples: 6, nonzeroSamples: 6, bytes: 48, elapsedMs: 5000 });
    time = 6000; counter.finish(); counter.finish(); assert.equal(events.length, 2); assert.equal(events[1].fields.phase, 'final');
    assert.doesNotMatch(JSON.stringify(events), /private-pcm|2147483647|"data"/);
    const empty = createPcmDiagnosticCounter({ session: 'empty', backend: 'asio', channels: 2, clock: () => time });
    empty.finish(); assert.equal(events.at(-1).fields.bytes, 0);
});
test('disabled PCM observation neither scans buffers nor calls its clock or publisher', () => {
    let touched = 0;
    const bytes = new Proxy({}, { get() { touched++; throw new Error('Buffer must not be inspected'); } });
    const counter = createPcmDiagnosticCounter({ session: 'private', channels: 2, enabled: () => false,
        clock: () => { touched++; throw new Error(); }, publish: () => { touched++; } });
    counter.observe(bytes); counter.finish(); assert.equal(touched, 0);
    assert.equal(publishPreviewDiagnostic('native.pcm', bytes), false); assert.equal(previewSessionRef('private'), undefined);
});
