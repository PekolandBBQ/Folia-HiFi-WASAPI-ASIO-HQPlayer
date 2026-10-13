'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { observeSpotifyOperation, observeSpotifyService } = require('../../electron/spotify/privatePreviewObserver.cjs');

// test/node/spotifyPreviewDiagnostics.test.cjs — real observer/registration paths with inert account and output boundaries.
function sink(t) {
    const events = []; const detach = installPreviewDiagnosticSink({ enabled: () => true,
        record(type, fields) { events.push({ type, fields }); return true; } });
    t.after(detach); return events;
}
function loadService(overrides = {}) {
    const file = require.resolve('../../electron/spotify/service.cjs'), originalRequire = createRequire(file), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(file),
        require: name => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name), process, Promise, Buffer, console }, { filename: file });
    return module.exports;
}
test('observations preserve returned values, synchronous errors and rejected error identity without serializing unknown fields', async t => {
    const events = sink(t); let calls = 0, getters = 0;
    const value = { privateAccount: 'secret-account', data: Buffer.from('private-audio'), toJSON() { getters++; throw new Error(); } };
    Object.defineProperty(value, 'state', { get() { getters++; throw new Error(); } });
    Object.defineProperty(value, 'then', { get() { getters++; throw new Error(); } });
    assert.equal(observeSpotifyOperation('service', { action: 'audio', quality: 'lossless', id: 'private-track', requestId: 'private-request' }, () => { calls++; return value; }), value);
    const error = Object.assign(new Error('private-rejection'), { code: 'APPLIANCE_CHANGED' });
    assert.throws(() => observeSpotifyOperation('service', { action: 'search', query: 'private-query' }, () => { calls++; throw error; }), item => item === error);
    const success = { playing: true, account: 'private-account' };
    assert.equal(await observeSpotifyOperation('service', { action: 'status' }, () => { calls++; return Promise.resolve(success); }), success);
    await assert.rejects(observeSpotifyOperation('service', { action: 'status' }, () => { calls++; return Promise.reject(error); }), item => item === error);
    assert.equal(calls, 4); assert.equal(getters, 0);
    assert.doesNotMatch(JSON.stringify(events), /private-|secret-|"data"|"id"|"query"/);
    const commands = events.filter(event => event.type === 'spotify.command');
    for (let index = 0; index < commands.length; index += 2) assert.equal(commands[index].fields.operationRef, commands[index + 1].fields.operationRef);
    assert.equal(commands[0].fields.requestedQuality, 'lossless'); assert.equal(commands[0].fields.sessionRef, 1);
    assert.equal(commands.at(-1).fields.errorCode, 'APPLIANCE_CHANGED');
});
test('successful browser pulls are silent, errors are immediate, and input/output getters are never inspected', async t => {
    const events = sink(t); let reads = 0;
    const bytes = { complete: false }; Object.defineProperty(bytes, 'data', { get() { reads++; throw new Error(); } });
    for (let index = 0; index < 300; index++) {
        assert.equal(await observeSpotifyOperation('browser-service', { action: 'pull', session: 'private-session' }, () => Promise.resolve(bytes)), bytes);
    }
    assert.equal(events.length, 0); assert.equal(reads, 0);
    const error = Object.assign(new Error('private-pcm-failure'), { code: 'PCM_INTERRUPTED' });
    await assert.rejects(observeSpotifyOperation('browser-service', { action: 'pull', session: 'private-session' }, () => Promise.reject(error)), item => item === error);
    assert.equal(events.length, 1); assert.equal(events[0].fields.command, 'browser-pull'); assert.equal(events[0].fields.errorCode, 'PCM_INTERRUPTED');
    assert.ok(events[0].fields.operationRef > 300);
});
test('disabled service observation performs no additional field reads or calls and returns its exact original promise', async () => {
    let reads = 0, calls = 0;
    const input = new Proxy({}, { getOwnPropertyDescriptor() { reads++; throw new Error(); } });
    const promise = Promise.resolve({ private: 'untouched' });
    assert.equal(observeSpotifyOperation('service', input, () => { calls++; return promise; }), promise);
    assert.equal(calls, 1); assert.equal(reads, 0);
});
test('ignored observed rejections remain fatal under the original Node policy', () => {
    const bus = require.resolve('../../electron/debug/privatePreviewDiagnosticBus.cjs');
    const observer = require.resolve('../../electron/spotify/privatePreviewObserver.cjs');
    const script = `require(${JSON.stringify(bus)}).installPreviewDiagnosticSink({enabled:()=>true,record(){return true}});require(${JSON.stringify(observer)}).observeSpotifyOperation('service',{action:'status'},()=>Promise.reject(new Error('private')));`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
    assert.equal(child.status, 1); assert.equal(child.signal, null);
});
test('production createSpotifyService observes its normal catalog calls without extra authentication or changing responses', async t => {
    const events = sink(t), response = { privateAccount: 'private-account' }; let requests = 0, authReads = 0;
    const serviceModule = loadService({
        './sessionVault.cjs': { createSessionVault: () => ({ token: () => { authReads++; }, clear: async () => {}, grantedScopes: () => [] }) },
        './deviceLogin.cjs': { createDeviceLogin: () => ({}) },
        './catalogLogin.cjs': { NCSPOT_CLIENT_ID: 'a'.repeat(32), createCatalogLogin: () => ({}) },
        './catalog.cjs': { createSpotifyCatalog: () => ({ request: async () => { requests++; return response; }, clear() {} }) },
        './cooldown.cjs': { createCooldown: () => ({}) },
        './loginCoordinator.cjs': { createLoginCoordinator: () => ({ clear() {} }) },
    });
    const service = serviceModule.createSpotifyService({ directory: '/unused', safeStorage: {} });
    assert.equal(await service.request({ action: 'status' }), response);
    assert.equal(await service.request({ action: 'search', query: 'private-query' }), response);
    await service.close(); assert.equal(requests, 2); assert.equal(authReads, 0);
    assert.ok(events.some(event => event.fields.layer === 'service' && event.fields.command === 'search'));
    assert.ok(events.some(event => event.fields.command === 'close' && event.fields.phase === 'release' && event.fields.releaseAcknowledged === true));
    assert.doesNotMatch(JSON.stringify(events), /private-account|private-query/);
});
test('registered normal, setup, browser and shutdown paths publish only bounded command/state acknowledgments', async t => {
    const events = sink(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-spotify-observed-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const serviceModule = loadService({ electron: { safeStorage: {}, net: { fetch() { throw new Error('No requests expected'); } }, shell: { openExternal() {} } }, qrcode: { toDataURL() {} } });
    let reads = 0, requests = 0, closes = 0, savedKey, quit = 0;
    const handlers = new Map(), app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: () => directory, quit() { quit++; } });
    const sender = { isDestroyed: () => false, send() {} }, ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
    const underlying = { request: async input => { requests++; return { action: input.action, privateAccount: 'private-account' }; },
        close: async () => { closes++; }, lookupSoloistPcmSource: () => null,
        requestBrowserPcm: async input => input.action === 'pull' ? { complete: false, data: new Uint8Array(8) }
            : { generation: 1, positionMs: 2000, sampleRate: 44100, channels: 2, bitDepth: 32, source: 'private-source' } };
    const appliance = { getSoloistConfiguration: () => ({}), publicStatus: async () => ({ state: 'stopped', hasKey: true }),
        saveKey: async key => { savedKey = key; return { state: 'stopped', hasKey: true }; },
        startSetup: async () => ({ state: 'pairing-required', hasKey: true }), stopSetup: async () => {}, logout: async () => {}, close: async () => {} };
    serviceModule.registerSpotify({ app, ipcMain, isTrustedSender: value => value === sender, applianceComposition: appliance,
        createService: () => underlying, createSoloist: () => ({ getServiceOptions: () => ({ ownedSoloist: { readFresh: () => { reads++; } } }), close: async () => {} }) });
    const request = input => handlers.get('spotify:request')({ sender }, input);
    const browser = input => handlers.get('spotify:browser-pcm')({ sender }, input);
    await request({ action: 'status' }); await request({ action: 'audio', quality: 'lossless', id: 'private-track', requestId: 'private-audio' });
    await browser({ action: 'begin', session: 'private-browser', url: 'http://127.0.0.1/private' });
    const before = events.length; await browser({ action: 'pull', session: 'private-browser' }); assert.equal(events.length, before);
    const key = `spak_${'A'.repeat(32)}`; await request({ action: 'playbackSetup', operation: 'saveKey', keyValue: key, requestId: 'private-setup' });
    assert.equal(savedKey, key); assert.equal(closes, 1); assert.equal(reads, 0); assert.equal(requests, 2);
    const setup = events.filter(event => event.fields.layer === 'setup' && event.fields.operation === 'saveKey');
    assert.deepEqual(setup.filter(event => event.type === 'spotify.command').map(event => event.fields.phase), ['request', 'result']);
    assert.ok(events.some(event => event.type === 'spotify.state' && event.fields.state === 'stopped'));
    assert.ok(events.some(event => event.type === 'spotify.state' && event.fields.outputBitsPerSample === 32 && event.fields.positionSeconds === 2));
    const count = events.length; await handlers.get('spotify:request')({ sender: {} }, { action: 'status' }); assert.equal(events.length, count);
    app.emit('before-quit', { preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(quit, 1); assert.ok(events.some(event => event.fields.command === 'shutdown' && event.fields.phase === 'release'));
    assert.doesNotMatch(JSON.stringify(events), /spak_|private-|127\.0\.0\.1|"data"|"hasKey"/);
});
