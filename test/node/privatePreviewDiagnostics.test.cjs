'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { unzipSync } = require('fflate');
const { installPrivatePreviewDiagnostics, IPC_CHANNEL } = require('../../electron/debug/privatePreviewDiagnostics.cjs');
const { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { DIRECTORY } = require('../../electron/debug/privatePreviewJournal.cjs');
const { inspectRejectedPauseResponse, DIRECTORY: INSPECTION_DIRECTORY } = require('../../electron/debug/pauseResponseInspection.cjs');

// test/node/privatePreviewDiagnostics.test.cjs — real safe exports and IPC/lifecycle semantics, no Electron execution.
function fixture(t, options = {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-private-ipc-'));
    const rendererEntry = path.join(profile, 'dist', 'index.html'), url = pathToFileURL(rendererEntry).href;
    let ownsLock = options.ownsLock ?? true;
    const app = Object.assign(new EventEmitter(), { hasSingleInstanceLock: () => ownsLock, isPackaged: true,
        requestSingleInstanceLock() { throw new Error('Must not acquire a lock'); } });
    const processObject = new EventEmitter(), handlers = new Map();
    const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
    const frame = { url }, sender = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
    const window = { webContents: sender, isDestroyed: () => false };
    const output = path.join(profile, 'export.zip'); let saves = 0, opens = 0;
    const manager = installPrivatePreviewDiagnostics({ app, ipcMain, processObject, profile, rendererEntry,
        getMainWindow: () => window, isTrustedSender: value => value === sender,
        dialog: { showSaveDialog: async () => { saves++; return { canceled: false, filePath: output }; } },
        shell: { openPath: async () => { opens++; return ''; } }, buildInfo: { buildId: '20261007', appVersion: '0.7.12', token: 'secret-token' }, ...options });
    t.after(() => { manager.close(); fs.rmSync(profile, { recursive: true, force: true }); });
    const event = { sender, senderFrame: frame };
    const invoke = (request, inputEvent = event) => handlers.get(IPC_CHANNEL)(inputEvent, request);
    const records = () => fs.readdirSync(path.join(profile, DIRECTORY)).filter(name => /^diagnostics\.[0-4]\.jsonl$/.test(name)).sort().reverse()
        .flatMap(name => fs.readFileSync(path.join(profile, DIRECTORY, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    return { profile, rendererEntry, url, app, processObject, manager, frame, sender, event, invoke, records, output,
        locks: value => { ownsLock = value; }, saves: () => saves, opens: () => opens };
}
test('IPC admits only exact local topframe including the fixed transparent-window splash variant', async t => {
    const f = fixture(t);
    assert.equal((await f.invoke({ action: 'status' })).available, true);
    const badEvents = [ {}, { sender: f.sender }, { sender: f.sender, senderFrame: { url: f.url } },
        { sender: { ...f.sender }, senderFrame: f.frame } ];
    for (const event of badEvents) assert.equal((await f.invoke({ action: 'status' }, event)).errorCode, 'UNTRUSTED_CALLER');
    for (const url of ['https://attacker.test/index.html', `${f.url}?remote=1`, `${f.url}#private`, `${f.url}?splash=0&secret=1`, `${f.url}?splash=1`]) {
        f.frame.url = url; assert.equal((await f.invoke({ action: 'export' })).errorCode, 'UNTRUSTED_CALLER');
    }
    f.frame.url = `${f.url}?splash=0`; assert.equal((await f.invoke({ action: 'status' })).available, true);
    for (const fragment of ['#player', '#home', '#lattice', '#search/test',
        '#collection/online/spotify/playlist/spotify-liked-songs', '?splash=0#collection/local/playlist/test']) {
        f.frame.url = `${f.url}${fragment}`;
        assert.equal((await f.invoke({ action: 'record', event: 'output.handoff', fields: { phase: 'requested', toBackend: 'hqplayer' } })).ok, true);
    }
    assert.equal(f.saves(), 0);
});
test('renderer records are a narrow handoff allowlist, with fields reprojected and no file destination from IPC', async t => {
    const f = fixture(t);
    assert.equal((await f.invoke({ action: 'record', event: 'output.handoff', fields: { phase: 'restored', toBackend: 'asio', sessionRef: 2,
        positionSeconds: 32, path: '/private/audio', uri: 'spotify:track:private', token: 'secret', source: Buffer.from('raw pcm') } })).ok, true);
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.auth-read', fields: { phase: 'result', ok: true } })).errorCode, 'INVALID_REQUEST');
    assert.equal((await f.invoke({ action: 'record', event: 'renderer.native-error', fields: { operation: 'play', errorCode: 'DECODE_FAILED', message: 'raw-private' } })).ok, true);
    assert.doesNotMatch(JSON.stringify(f.records()), /secret|private\/audio|spotify:track|raw-private|raw pcm/);
    assert.equal(f.records().at(-1).fields.errorCode, 'DECODE_FAILED');
});
test('the duplicate instance cannot acquire a lock, create files or publish via the global bus', async t => {
    const f = fixture(t, { ownsLock: false });
    assert.equal(isPreviewDiagnosticsEnabled(), false); assert.equal(previewSessionRef('private-id'), undefined);
    assert.equal(publishPreviewDiagnostic('native.command', { operation: 'play', phase: 'request' }), false);
    f.app.emit('ready'); assert.equal((await f.invoke({ action: 'status' })).recording, false);
    assert.deepEqual(fs.readdirSync(f.profile), []);
    f.locks(true); f.app.emit('ready'); assert.equal(isPreviewDiagnosticsEnabled(), true);
    assert.equal(f.records().length, 1);
    f.locks(false); const count = f.records().length;
    f.manager.record('native.command', { operation: 'play', phase: 'request' }); assert.equal(f.records().length, count);
});
test('steady progress/state records sample at one Hz but transitions and errors persist immediately', t => {
    let time = 1000; const f = fixture(t, { clock: () => time });
    for (let index = 0; index < 20; index++) f.manager.record('native.progress', { sessionRef: 1, stage: 'download', loaded: index });
    f.manager.record('native.progress', { sessionRef: 1, stage: 'decode' });
    time += 1000; f.manager.record('native.progress', { sessionRef: 1, stage: 'decode' });
    f.manager.record('native.state', { sessionRef: 1, playing: true, positionSeconds: 1 });
    f.manager.record('native.state', { sessionRef: 1, playing: true, positionSeconds: 1.2 });
    f.manager.record('native.state', { sessionRef: 1, playing: false, positionSeconds: 1.2 });
    for (let index = 0; index < 3; index++) f.manager.record('native.state', { sessionRef: 1, errorCode: 'DEVICE_UNAVAILABLE' });
    assert.equal(f.records().filter(record => record.type === 'native.progress').length, 3);
    assert.equal(f.records().filter(record => record.type === 'native.state').length, 5);
});
test('safe lifecycle categories exclude error text, process names, URLs and raw child details', t => {
    const f = fixture(t); f.app.emit('ready');
    f.processObject.emit('uncaughtExceptionMonitor', new Error('token=secret /private/file'));
    f.app.emit('render-process-gone', null, { getURL: () => 'https://private.test' }, { reason: 'crashed', exitCode: 7 });
    f.app.emit('child-process-gone', null, { type: 'Utility', reason: 'oom', exitCode: 9, name: 'private-name' });
    f.app.emit('child-process-gone', null, { type: 'secret-process', reason: 'private-error', exitCode: Infinity });
    const records = f.records(); assert.doesNotMatch(JSON.stringify(records), /secret|private|token=/);
    assert.deepEqual(records.at(-1).fields, { kind: 'unknown', reason: 'unknown' });
    assert.equal(f.processObject.listenerCount('uncaughtException'), 0);
});
test('observing rejections never creates a policy or retains one after the app removes its handler', t => {
    const f = fixture(t);
    assert.equal(f.manager.observeExistingRejectionHandler(), false); assert.equal(f.processObject.listenerCount('unhandledRejection'), 0);
    const seen = [], original = value => seen.push(value); f.processObject.on('unhandledRejection', original);
    assert.equal(f.manager.observeExistingRejectionHandler(), true); assert.equal(f.manager.observeExistingRejectionHandler(), false);
    const rejection = new Error('private'); f.processObject.emit('unhandledRejection', rejection);
    assert.equal(seen[0], rejection); assert.equal(f.processObject.listeners('unhandledRejection')[0], original);
    assert.equal(f.records().at(-1).fields.reason, 'unhandled-rejection');
    f.processObject.removeListener('unhandledRejection', original);
    assert.equal(f.processObject.listenerCount('unhandledRejection'), 0);
});
test('real uncaught exceptions and unhandled rejections still terminate the Node process', t => {
    const f = fixture(t); f.manager.close();
    const modulePath = require.resolve('../../electron/debug/privatePreviewDiagnostics.cjs');
    for (const statement of ["throw new Error('private-fatal')", "Promise.reject(new Error('private-rejection'))"]) {
        const script = `const {EventEmitter}=require('node:events'); const app=Object.assign(new EventEmitter(),{hasSingleInstanceLock:()=>true}); const d=require(${JSON.stringify(modulePath)}).installPrivatePreviewDiagnostics({app,ipcMain:{handle(){}},profile:${JSON.stringify(f.profile)},rendererEntry:${JSON.stringify(f.rendererEntry)}});d.observeExistingRejectionHandler();${statement};`;
        const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
        assert.equal(child.status, 1); assert.equal(child.signal, null);
    }
    const records = f.records(); assert.equal(records.filter(record => record.fields.reason === 'uncaught-exception').length, 2);
    assert.doesNotMatch(JSON.stringify(records), /private-fatal|private-rejection/);
});
test('local export uses the save dialog and includes only reprojected logs plus scoped build metadata', async t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.profile, 'logs')); fs.writeFileSync(path.join(f.profile, 'logs', 'crash.log'), 'secret-legacy-crash');
    fs.writeFileSync(path.join(f.profile, 'account.json'), 'secret-account');
    f.manager.record('native.command', { operation: 'play', phase: 'request', url: 'https://private.test' });
    const file = path.join(f.profile, DIRECTORY, 'diagnostics.0.jsonl');
    const poisoned = { ...f.records().at(-1), rawToken: 'secret-token' }; fs.appendFileSync(file, `${JSON.stringify(poisoned)}\n`);
    assert.deepEqual(await f.invoke({ action: 'export', path: '/unrequested.zip' }), { ok: true });
    assert.equal(f.saves(), 1);
    const zipped = unzipSync(fs.readFileSync(f.output));
    assert.deepEqual(Object.keys(zipped).sort(), ['build-info.json', 'diagnostics.jsonl', 'export-info.json']);
    const text = Object.values(zipped).map(bytes => Buffer.from(bytes).toString('utf8')).join('');
    assert.doesNotMatch(text, /secret|private\.test|account.json|crash.log/);
    const build = JSON.parse(Buffer.from(zipped['build-info.json'])); assert.equal(build.buildInfoScope, 'matching-build-ref-only');
    assert.equal(build.buildInfo.buildId, '20261007'); assert.equal(f.manager.status().exportedArchives, 1);
    assert.equal((await f.invoke({ action: 'openFolder' })).ok, true); assert.equal(f.opens(), 1);
});
test('exports cable setup and helper facts without upgrading endpoint or launch evidence to installation proof', async t => {
    const f = fixture(t);
    f.manager.record('spotify.cable-setup', { operation: 'openCablePanel', state: 'selection-required',
        captureEndpointCount: 1, renderEndpointCount: 1, endpointPairDetected: true, vendorLaunchAcknowledged: true,
        installationVerification: 'unknown', driverInstalled: true, endpointId: 'secret-device', path: 'secret-path' });
    f.manager.record('spotify.capture-helper', { phase: 'inventory', operation: 'devices',
        captureEndpointCount: 1, renderEndpointCount: 1, singleCaptureMixSampleRate: 48000,
        singleRenderMixSampleRate: 48000, processPlatform: 'win32', processArchitecture: 'x64', token: 'secret-token' });
    assert.deepEqual(await f.invoke({ action: 'export' }), { ok: true });
    const zipped = unzipSync(fs.readFileSync(f.output));
    const text = Buffer.from(zipped['diagnostics.jsonl']).toString('utf8');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    const setup = rows.find(row => row.type === 'spotify.cable-setup');
    const helper = rows.find(row => row.type === 'spotify.capture-helper');
    assert.equal(setup.fields.installationVerification, 'unknown'); assert.equal(setup.fields.vendorLaunchAcknowledged, true);
    assert.equal(helper.fields.singleCaptureMixSampleRate, 48000); assert.equal(helper.fields.singleRenderMixSampleRate, 48000);
    assert.doesNotMatch(text, /secret-|driverInstalled|endpointId/);
});
test('exports only bounded physical-owner failure facts and rejects incomplete or renderer-injected proof', async t => {
    const f = fixture(t);
    f.manager.record('spotify.route-owner-proof', { operation: 'inspect', errorCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',
        stage: 'owner-parent', reason: 'api-failed', role: 0, originalKind: 'default', depth: 1,
        nativeResult: 13, hresult: -2147467259, property: 'device-id', propertyType: 18, propertyLength: 160, bus: 'vendor',
        ownerId: 'private-serial', hardwareIds: ['private-hardware'], rawPolicy: 'private-policy', message: 'private-error' });
    f.manager.record('spotify.route-owner-proof', { operation: 'inspect', errorCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',
        stage: 'unknown-caller-stage', reason: 'api-failed' });
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.route-owner-proof', fields: {
        operation: 'inspect', errorCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN', stage: 'owner-parent', reason: 'api-failed',
    } })).errorCode, 'INVALID_REQUEST');
    await f.invoke({ action: 'export' });
    const zipped = unzipSync(fs.readFileSync(f.output));
    const text = Buffer.from(zipped['diagnostics.jsonl']).toString('utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'spotify.route-owner-proof');
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].fields, { operation: 'inspect', errorCode: 'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',
        stage: 'owner-parent', reason: 'api-failed', role: 0, originalKind: 'default', depth: 1,
        nativeResult: 13, hresult: -2147467259, property: 'device-id', propertyType: 18, propertyLength: 160, bus: 'vendor' });
    assert.doesNotMatch(text, /private-serial|private-hardware|private-policy|private-error|unknown-caller-stage|ownerId|hardwareIds|rawPolicy/);
});
test('cancelled and repeated export clicks are bounded and do not write a file', async t => {
    let resolve, calls = 0;
    const pending = new Promise(done => { resolve = done; });
    const f = fixture(t, { dialog: { showSaveDialog: () => { calls++; return pending; } } });
    const first = f.invoke({ action: 'export' });
    assert.equal((await f.invoke({ action: 'export' })).busy, true); assert.equal(f.manager.status().busy, true);
    resolve({ canceled: true }); assert.equal((await first).canceled, true);
    assert.equal(f.manager.status().busy, false); assert.equal(f.manager.status().exportedArchives, 0);
    assert.equal(fs.existsSync(f.output), false); assert.equal(calls, 1);
});
test('cold bootstrap diagnostics preserve finite control stages without raw state or renderer authority', async t => {
    const f = fixture(t);
    const { reportSpotifyColdBootstrap } = require('../../electron/spotify/requestDiagnostics.cjs');
    let getterReads = 0;
    const facts = { errorCode: Object.assign(new Error('private-response'), { code: 'PLAYBACK_STATE_UNCONFIRMED' }),
        causeCode: { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' }, baselineEmpty: true, observedEmpty: false,
        deviceMatched: true, paused: true, selectInvoked: false, selectConfirmed: false,
        activationConfirmed: true, receiptRetained: true, originalVolume: 9,
        raw: 'private-response', deviceId: 'private-device', trackId: 'private-track' };
    Object.defineProperty(facts, 'volumeMatched', { get() { getterReads++; throw new Error('private-getter'); } });
    reportSpotifyColdBootstrap('private-session', 'activate', 'failed', facts);
    reportSpotifyColdBootstrap('private-session', 'private-stage', 'failed', facts);
    assert.equal(getterReads, 0);
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.cold-bootstrap', fields: {
        sessionRef: 1, stage: 'activate', phase: 'failed', receiptRetained: true,
    } })).errorCode, 'INVALID_REQUEST');
    const rows = f.records().filter(row => row.type === 'spotify.cold-bootstrap');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].fields, { sessionRef: 1, stage: 'activate', phase: 'failed',
        errorCode: 'PLAYBACK_STATE_UNCONFIRMED', causeCode: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED',
        baselineEmpty: true, observedEmpty: false, deviceMatched: true, paused: true,
        selectInvoked: false, selectConfirmed: false, activationConfirmed: true, receiptRetained: true });
    assert.doesNotMatch(JSON.stringify(rows), /private-|originalVolume|deviceId|trackId|raw/);
});
test('export fails closed when a recognized journal or selected destination becomes a symlink', async t => {
    const f = fixture(t); f.manager.record('native.command', { operation: 'play', phase: 'request' });
    const target = path.join(f.profile, 'sensitive'); fs.writeFileSync(target, 'untouched'); fs.symlinkSync(target, f.output);
    assert.equal((await f.invoke({ action: 'export' })).errorCode, 'EXPORT_FAILED'); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    fs.unlinkSync(f.output);
    const log = path.join(f.profile, DIRECTORY, 'diagnostics.0.jsonl'); fs.unlinkSync(log); fs.symlinkSync(target, log);
    assert.equal((await f.invoke({ action: 'export' })).ok, false); assert.equal(fs.existsSync(f.output), false);
    assert.equal(f.manager.status().exportErrors, 1);
});

const inspectionTick = () => new Promise(resolve => setImmediate(resolve));
test('trusted GUI arms once without an environment flag and status/exports disclose no inspection bytes or destination', async t => {
    const f = fixture(t), directory = path.join(f.profile, INSPECTION_DIRECTORY);
    assert.equal((await f.invoke({ action: 'status' })).pauseResponseInspection, 'idle');
    assert.equal(fs.existsSync(directory), false);
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: ignored before arm.')), false);
    const expected = { ok: true, pauseResponseInspection: 'armed' };
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection', path: '/unrequested', body: 'raw' }), expected);
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection' }), expected);
    assert.equal((await f.invoke({ action: 'status' })).pauseResponseInspection, 'armed');
    const body = 'Error for SYNTHETIC_PRIVATE_TOKEN person@example.com';
    assert.equal(inspectRejectedPauseResponse(Buffer.from(body)), true);
    assert.equal(f.manager.status().pauseResponseInspection, 'armed');
    await inspectionTick();
    assert.equal((await f.invoke({ action: 'status' })).pauseResponseInspection, 'captured');
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection' }), { ok: true, pauseResponseInspection: 'captured' });
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: second capture.')), false);
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.deepEqual(await f.invoke({ action: 'export' }), { ok: true });
    const exported = Object.values(unzipSync(fs.readFileSync(f.output))).map(value => Buffer.from(value).toString()).join('');
    const replies = JSON.stringify([await f.invoke({ action: 'status' }), await f.invoke({ action: 'armPauseResponseInspection' })]);
    for (const text of [exported, replies]) {
        assert.doesNotMatch(text, /SYNTHETIC_PRIVATE|person@example|bodyBase64|localCandidate|blocked-sensitive|private-pause-inspection/);
        assert.equal(text.includes(Buffer.from(body).toString('base64')), false);
        assert.equal(text.includes(f.profile), false);
    }
});
test('untrusted, nonprivate and lockless callers cannot arm the inspection', async t => {
    const f = fixture(t), directory = path.join(f.profile, INSPECTION_DIRECTORY);
    assert.equal((await f.invoke({ action: 'armPauseResponseInspection' }, {})).errorCode, 'UNTRUSTED_CALLER');
    f.frame.url = 'https://attacker.test/index.html';
    assert.equal((await f.invoke({ action: 'armPauseResponseInspection' })).errorCode, 'UNTRUSTED_CALLER');
    f.frame.url = f.url; f.locks(false);
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection' }), { ok: false, pauseResponseInspection: 'unavailable', errorCode: 'UNAVAILABLE' });
    assert.equal(fs.existsSync(directory), false); f.manager.close();
    const ordinary = fixture(t, { enabled: false });
    assert.deepEqual(await ordinary.invoke({ action: 'armPauseResponseInspection' }), { ok: false, pauseResponseInspection: 'unavailable', errorCode: 'UNAVAILABLE' });
    assert.equal(ordinary.manager.status().pauseResponseInspection, 'unavailable');
    assert.deepEqual(fs.readdirSync(ordinary.profile), []);
});
test('closing the diagnostic host revokes a queued capture and rejects a second installer in the same process', async t => {
    const f = fixture(t);
    await f.invoke({ action: 'armPauseResponseInspection' });
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: pending capture.')), true);
    f.manager.close(); await inspectionTick();
    assert.equal(f.manager.status().pauseResponseInspection, 'unavailable');
    assert.deepEqual(fs.readdirSync(path.join(f.profile, INSPECTION_DIRECTORY)), []);
    const replacement = fixture(t, { processObject: f.processObject });
    assert.equal((await replacement.invoke({ action: 'status' })).pauseResponseInspection, 'unavailable');
    assert.deepEqual(await replacement.invoke({ action: 'armPauseResponseInspection' }), { ok: false, pauseResponseInspection: 'unavailable', errorCode: 'UNAVAILABLE' });
    assert.equal(fs.existsSync(path.join(replacement.profile, INSPECTION_DIRECTORY)), false);
});
test('an unsafe arm destination fails once and cannot retry after the pathname is repaired', async t => {
    const f = fixture(t), directory = path.join(f.profile, INSPECTION_DIRECTORY);
    fs.symlinkSync(f.profile, directory, 'dir');
    const expected = { ok: false, pauseResponseInspection: 'failed', errorCode: 'INSPECTION_FAILED' };
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection' }), expected);
    fs.unlinkSync(directory);
    assert.deepEqual(await f.invoke({ action: 'armPauseResponseInspection' }), expected);
    assert.equal((await f.invoke({ action: 'status' })).pauseResponseInspection, 'failed');
    assert.equal(fs.existsSync(directory), false);
});

test('playlist correlation IDs are consumed only by trusted local IPC and never persist or export', async t => {
    const f = fixture(t), id = 'Z'.repeat(22);
    const { previewPlaylistRef } = require('../../electron/spotify/playlistDiagnostics.cjs');
    const playlistRef = previewPlaylistRef(id);
    const fields = { phase: 'cache-before', playlistId: id, refreshRef: 42, source: 'public',
        title: 'PRIVATE_TITLE_SENTINEL', accountId: 'PRIVATE_ACCOUNT_SENTINEL', cookie: 'PRIVATE_COOKIE_SENTINEL',
        url: 'https://PRIVATE_URL', responseBody: 'PRIVATE_BODY_SENTINEL' };
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.library', fields }, {})).errorCode, 'UNTRUSTED_CALLER');
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.library', fields })).ok, true);
    assert.deepEqual(f.records().at(-1).fields, { phase: 'cache-before', refreshRef: 42, source: 'public', playlistRef });
    assert.equal((await f.invoke({ action: 'record', event: 'spotify.playlist', fields: { phase: 'fallback-result', eligible: true } })).errorCode, 'INVALID_REQUEST');
    await f.invoke({ action: 'export' });
    const archive = unzipSync(fs.readFileSync(f.output));
    const text = Object.values(archive).map(bytes => Buffer.from(bytes).toString('utf8')).join('');
    assert.doesNotMatch(text, /ZZZZ|PRIVATE_|https?:|playlistId|accountId|responseBody|cookie/);
    assert.ok(text.includes('"playlistRef":' + playlistRef));
});

test('endpoint rejection details survive native projection and diagnostic export',async t=>{
 const {physicalOwnerDiagnostic}=require('../../electron/spotify/ownedRouteProtocol.cjs');const f=fixture(t);
 const fields={stage:'endpoint-policy',reason:'target-is-original',role:0,originalKind:'explicit',endpointState:1,endpointFlow:0,targetMatch:true,policyMatch:true};
 assert.deepEqual(physicalOwnerDiagnostic(fields),fields);
 f.manager.record('spotify.route-owner-proof',{operation:'inspect',errorCode:'ORIGINAL_ENDPOINT_UNSAFE',...fields});
 await f.invoke({action:'export'});const zipped=unzipSync(fs.readFileSync(f.output));
 const rows=Buffer.from(zipped['diagnostics.jsonl']).toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
 const row=rows.find(row=>row.type==='spotify.route-owner-proof');assert.deepEqual(row.fields,{operation:'inspect',errorCode:'ORIGINAL_ENDPOINT_UNSAFE',...fields});
});
