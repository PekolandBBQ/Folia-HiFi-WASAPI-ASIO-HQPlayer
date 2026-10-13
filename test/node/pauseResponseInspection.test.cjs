'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { installPauseResponseInspection, inspectRejectedPauseResponse, DIRECTORY, MAX_REPORT_BYTES } = require('../../electron/debug/pauseResponseInspection.cjs');

// test/node/pauseResponseInspection.test.cjs — bounded local commit, revocation, and failure-state checks.
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-inspection-state-'));
    let enabled = true;
    const unbind = installPreviewDiagnosticSink({ enabled: () => enabled, record: () => true });
    const processObject = {}, inspection = installPauseResponseInspection({ profile, processObject,
        enabled: () => enabled, ...overrides });
    t.after(() => { inspection(); unbind(); fs.rmSync(profile, { recursive: true, force: true }); });
    const directory = path.join(profile, DIRECTORY);
    return { profile, directory, inspection, processObject, setEnabled: value => { enabled = value; },
        files: () => fs.existsSync(directory) ? fs.readdirSync(directory) : [] };
}
test('a successful capture is acknowledged only after write, fsync, final identity checks and close', async t => {
    const stages = []; let f;
    const fsImpl = { ...fs,
        writeSync(...args) { stages.push(['write', f.inspection.status()]); return fs.writeSync(...args); },
        fsyncSync(...args) { stages.push(['fsync', f.inspection.status()]); return fs.fsyncSync(...args); },
        closeSync(...args) { stages.push(['close', f.inspection.status()]); return fs.closeSync(...args); } };
    f = fixture(t, { fsImpl });
    assert.equal(f.inspection.status(), 'idle'); assert.equal(fs.existsSync(f.directory), false);
    assert.equal(f.inspection.arm(), 'armed');
    for (const bytes of [new Uint8Array(0), new Uint8Array(129), 'Error: invalid type.']) assert.equal(inspectRejectedPauseResponse(bytes), false);
    assert.equal(f.inspection.status(), 'armed');
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: playback failed.')), true);
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: duplicate.')), false);
    assert.equal(f.inspection.status(), 'armed'); await tick();
    assert.deepEqual(stages, [['write', 'armed'], ['fsync', 'armed'], ['close', 'armed']]);
    assert.equal(f.inspection.status(), 'captured'); assert.equal(f.inspection.arm(), 'captured');
    assert.equal(f.files().length, 1);
    const file = path.join(f.directory, f.files()[0]); assert.ok(fs.statSync(file).size <= MAX_REPORT_BYTES);
    assert.equal(Buffer.from(JSON.parse(fs.readFileSync(file)).bodyBase64, 'base64').toString(), 'Error: playback failed.');
});
for (const failure of ['open', 'write', 'short-write', 'fsync', 'final-identity', 'final-length', 'close']) {
    test(`${failure} failure consumes one attempt and never acknowledges a capture`, async t => {
        let opens = 0, fstats = 0;
        const fsImpl = { ...fs,
            openSync(...args) { opens++; if (failure === 'open') throw new Error('PRIVATE_PATH'); return fs.openSync(...args); },
            writeSync(...args) {
                if (failure === 'write') throw new Error('PRIVATE_WRITE');
                if (failure === 'short-write') return 0;
                return fs.writeSync(...args);
            },
            fsyncSync(...args) { if (failure === 'fsync') throw new Error('PRIVATE_FLUSH'); return fs.fsyncSync(...args); },
            fstatSync(...args) {
                const stat = fs.fstatSync(...args);
                if (++fstats === 2 && failure === 'final-identity') stat.ino += 1n;
                if (fstats === 2 && failure === 'final-length') stat.size += 1n;
                return stat;
            },
            closeSync(...args) { fs.closeSync(...args); if (failure === 'close') throw new Error('PRIVATE_CLOSE'); },
        };
        const f = fixture(t, { fsImpl });
        assert.equal(f.inspection.arm(), 'armed');
        assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: playback failed.')), true);
        await tick(); assert.equal(f.inspection.status(), 'failed');
        assert.equal(f.inspection.arm(), 'failed');
        assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: second capture.')), false);
        await tick(); assert.equal(opens, 1);
        assert.doesNotMatch(JSON.stringify(f.inspection.status()), /PRIVATE|body|path|filter/);
    });
}
test('directory replacement after arming is rejected before any raw-body write', async t => {
    const f = fixture(t); f.inspection.arm();
    const original = `${f.directory}-old`; fs.renameSync(f.directory, original); fs.mkdirSync(f.directory);
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: moved directory.')), true);
    await tick(); assert.equal(f.inspection.status(), 'failed');
    assert.deepEqual(f.files(), []); assert.deepEqual(fs.readdirSync(original), []);
});
test('lock revocation after queueing prevents the file write and consumes the attempt', async t => {
    const f = fixture(t); f.inspection.arm();
    assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: pending.')), true);
    f.setEnabled(false); assert.equal(f.inspection.status(), 'unavailable');
    await tick(); assert.deepEqual(f.files(), []);
    f.setEnabled(true); assert.equal(f.inspection.status(), 'failed'); assert.equal(f.inspection.arm(), 'failed');
});
for (const at of ['queued', 'open', 'write', 'fsync', 'close']) {
    test(`closure at ${at} revokes the collector without a completed status or second attempt`, async t => {
        let f, writes = 0;
        const fsImpl = { ...fs,
            openSync(...args) { const fd = fs.openSync(...args); if (at === 'open') f.inspection(); return fd; },
            writeSync(...args) { writes++; const size = fs.writeSync(...args); if (at === 'write') f.inspection(); return size; },
            fsyncSync(...args) { fs.fsyncSync(...args); if (at === 'fsync') f.inspection(); },
            closeSync(...args) { fs.closeSync(...args); if (at === 'close') f.inspection(); },
        };
        f = fixture(t, { fsImpl }); f.inspection.arm();
        assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: pending.')), true);
        if (at === 'queued') f.inspection();
        await tick(); assert.equal(f.inspection.status(), 'unavailable');
        assert.equal(f.inspection.arm(), 'unavailable');
        assert.equal(inspectRejectedPauseResponse(Buffer.from('Error: after close.')), false);
        if (at === 'queued' || at === 'open') assert.equal(writes, 0);
        const replacement = installPauseResponseInspection({ profile: f.profile, processObject: f.processObject, enabled: () => true });
        assert.equal(replacement.status(), 'unavailable'); assert.equal(replacement.arm(), 'unavailable'); replacement();
    });
}
test('a setup exception is terminal even after reinstalling against the same process', t => {
    let attempts = 0;
    const f = fixture(t, { fsImpl: { ...fs, mkdirSync() { attempts++; throw new Error('PRIVATE_SETUP'); } } });
    assert.equal(f.inspection.arm(), 'failed'); assert.equal(f.inspection.arm(), 'failed');
    assert.equal(attempts, 1); f.inspection();
    const replacement = installPauseResponseInspection({ profile: f.profile, processObject: f.processObject, enabled: () => true });
    assert.equal(replacement.status(), 'unavailable'); assert.equal(replacement.arm(), 'unavailable');
    assert.equal(fs.existsSync(f.directory), false); replacement();
});
