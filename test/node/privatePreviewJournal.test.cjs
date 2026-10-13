'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPrivatePreviewJournal, MAX_FILE_BYTES, DIRECTORY } = require('../../electron/debug/privatePreviewJournal.cjs');
const { projectBuildInfo, buildReference, sourceErrorCode, projectEvent } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');

// test/node/privatePreviewJournal.test.cjs — real files, restart/death, retention and tampering boundaries.
const input = { operation: 'play', phase: 'request', sessionRef: 1 };
function fixture(t, options = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-safe-journal-'));
    const profile = path.join(base, 'profile'); fs.mkdirSync(profile);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const directory = path.join(profile, DIRECTORY);
    return { base, profile, directory, journal: createPrivatePreviewJournal({ profile, ...options }) };
}
const logs = directory => fs.readdirSync(directory).filter(name => /^diagnostics\.\d\.jsonl$/.test(name));
test('persists more than 160 observations synchronously with UTC, monotone sequence and private run IDs', t => {
    const { journal, directory } = fixture(t, { buildInfo: { buildId: '20261007', appVersion: '0.7.12' } });
    for (let index = 0; index < 181; index++) assert.equal(journal.append('native.command', input), true);
    const records = journal.snapshot().records;
    assert.equal(records.length, 181); assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 181 }, (_, index) => index + 1));
    assert.equal(new Set(records.map(record => record.runId)).size, 1);
    assert.match(records[0].timestamp, /^\d{4}-\d\d-\d\dT.*Z$/); assert.match(records[0].buildRef, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(path.join(directory, 'diagnostics.0.jsonl'), 'utf8').split('\n').length, 182);
    assert.equal(records[0].build, undefined);
});
test('a new run appends existing complete lines and retains the earlier build reference after startup rotation', t => {
    const f = fixture(t, { maxFileBytes: 850, buildInfo: { buildId: '20261007' } });
    for (let index = 0; index < 10; index++) f.journal.append('native.command', input);
    const first = f.journal.snapshot(); f.journal.close();
    const next = createPrivatePreviewJournal({ profile: f.profile, maxFileBytes: 850, buildInfo: { buildId: '20261008' } });
    for (let index = 0; index < 4; index++) next.append('native.command', input);
    const snapshot = next.snapshot();
    assert.ok(snapshot.records.some(record => record.buildRef === first.buildRef));
    assert.ok(snapshot.records.some(record => record.buildRef === snapshot.buildRef));
    assert.notEqual(first.buildRef, snapshot.buildRef);
    assert.equal(new Set(snapshot.records.map(record => record.runId)).size, 2);
    assert.equal(snapshot.buildInfo.buildId, '20261008'); assert.equal(snapshot.buildInfoScope, 'matching-build-ref-only');
});
test('the last synchronous record survives a separate process exiting without close', t => {
    const f = fixture(t); f.journal.close();
    const modulePath = require.resolve('../../electron/debug/privatePreviewJournal.cjs');
    const script = `const j=require(${JSON.stringify(modulePath)}).createPrivatePreviewJournal({profile:${JSON.stringify(f.profile)}});j.append('native.command',{operation:'play',phase:'request'});process.exit(17);`;
    assert.equal(spawnSync(process.execPath, ['-e', script], { timeout: 5000 }).status, 17);
    const next = createPrivatePreviewJournal({ profile: f.profile });
    assert.equal(next.snapshot().records.length, 1); assert.equal(next.snapshot().records[0].fields.operation, 'play');
});
test('SIGKILL after an append leaves the fsynced record available to the next process', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); f.journal.close();
    const modulePath = require.resolve('../../electron/debug/privatePreviewJournal.cjs');
    const script = `const j=require(${JSON.stringify(modulePath)}).createPrivatePreviewJournal({profile:${JSON.stringify(f.profile)}});j.append('native.command',{operation:'seek',phase:'request',positionSeconds:19});process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 5000 });
    assert.equal(child.signal, 'SIGKILL');
    const next = createPrivatePreviewJournal({ profile: f.profile }); assert.equal(next.snapshot().records[0].fields.positionSeconds, 19);
});
test('rotation, restarts and lowered retention obey both byte and count caps', t => {
    const f = fixture(t, { maxFiles: 3, maxFileBytes: 800 });
    for (let index = 0; index < 120; index++) f.journal.append('native.command', { ...input, sessionRef: index });
    assert.equal(logs(f.directory).length, 3);
    for (const name of logs(f.directory)) assert.ok(fs.statSync(path.join(f.directory, name)).size <= 800);
    assert.ok(f.journal.status().totalBytes <= 2400); assert.ok(f.journal.snapshot().records.at(-1).fields.sessionRef === 119);
    fs.writeFileSync(path.join(f.directory, 'unrelated.log'), 'private-legacy');
    const next = createPrivatePreviewJournal({ profile: f.profile, maxFiles: 1, maxFileBytes: 800 });
    assert.equal(logs(f.directory).length, 1); assert.equal(next.append('native.command', input), true);
    assert.equal(fs.readFileSync(path.join(f.directory, 'unrelated.log'), 'utf8'), 'private-legacy');
    const bounds = createPrivatePreviewJournal({ profile: path.join(f.base, 'other'), maxFiles: 900, maxFileBytes: 2 ** 40 }).status();
    assert.equal(bounds.maxFiles, 5); assert.equal(bounds.maxFileBytes, MAX_FILE_BYTES);
});
test('short writes leave an isolated partial line, never splice a later event, and cannot loop forever', t => {
    let failWrites = false, written = 0;
    const fsImpl = Object.assign(Object.create(fs), { writeSync(fd, buffer, offset, length, position) {
        if (!failWrites) return fs.writeSync(fd, buffer, offset, length, position);
        if (++written === 1) return fs.writeSync(fd, buffer, offset, 9, position);
        return 0;
    } });
    const f = fixture(t, { fsImpl }); assert.equal(f.journal.append('native.command', input), true);
    failWrites = true; assert.equal(f.journal.append('native.command', input), false); assert.equal(written, 2);
    failWrites = false; assert.equal(f.journal.append('native.command', { ...input, operation: 'pause' }), true);
    const snapshot = f.journal.snapshot(); assert.equal(snapshot.records.length, 2); assert.equal(snapshot.rejectedRecords, 1);
    assert.deepEqual(snapshot.records.map(item => item.sequence), [1, 3]);
    const reopened = createPrivatePreviewJournal({ profile: f.profile });
    assert.equal(reopened.snapshot().rejectedRecords, 1); assert.equal(reopened.append('native.command', input), true);
});
test('permission and disk-full errors remain bounded and a later write can recover', t => {
    let blocked = false;
    const fsImpl = Object.assign(Object.create(fs), { writeSync(...args) { if (blocked) throw Object.assign(new Error('secret filesystem path'), { code: 'ENOSPC' }); return fs.writeSync(...args); } });
    const f = fixture(t, { fsImpl }); blocked = true;
    assert.equal(f.journal.append('native.command', input), false); assert.equal(f.journal.status().errorCode, 'IO_FAILED');
    blocked = false; assert.equal(f.journal.append('native.command', input), true); assert.equal(f.journal.status().writeErrors, 1);
    assert.equal(f.journal.status().errorCode, undefined);
    const unavailable = createPrivatePreviewJournal({ profile: path.join(f.base, 'blocked'), fsImpl: Object.assign(Object.create(fs), { mkdirSync() { throw Object.assign(new Error('private'), { code: 'EACCES' }); } }) });
    assert.equal(unavailable.status().available, false); assert.equal(unavailable.append('native.command', input), false);
});
test('invalid events and invalid clocks fail before consuming sequences or writing', t => {
    let time = new Date('2026-10-07T00:00:00.000Z');
    const f = fixture(t, { now: () => time, runId: 'private account id' });
    assert.equal(f.journal.append('raw-account-event', { token: 'secret' }), false);
    time = new Date(NaN); assert.equal(f.journal.append('native.command', input), false);
    time = new Date('2026-10-07T00:00:00.000Z'); assert.equal(f.journal.append('native.command', input), true);
    const record = f.journal.snapshot().records[0]; assert.equal(record.sequence, 1); assert.notEqual(record.runId, 'private account id');
    assert.equal(f.journal.status().rejectedRecords, 2);
});
test('unsafe profiles, outside directories and symlinked ancestry fail without touching destinations', t => {
    const f = fixture(t); const target = path.join(f.base, 'target'); fs.mkdirSync(target);
    const link = path.join(f.base, 'redirect'); fs.symlinkSync(target, link, 'dir');
    for (const options of [{ profile: '/' }, { profile: 'relative' }, { profile: link }, { profile: f.profile, directory: target }]) {
        const journal = createPrivatePreviewJournal(options); assert.equal(journal.status().available, false); assert.equal(journal.append('native.command', input), false);
    }
    assert.deepEqual(fs.readdirSync(target), []);
});
test('symlinked, hardlinked and directory log members are rejected without changing targets', t => {
    const f = fixture(t); const target = path.join(f.base, 'target'); fs.writeFileSync(target, 'private-target');
    const name = path.join(f.directory, 'diagnostics.0.jsonl');
    for (const make of [() => fs.symlinkSync(target, name), () => fs.linkSync(target, name), () => fs.mkdirSync(name)]) {
        make(); const journal = createPrivatePreviewJournal({ profile: f.profile });
        assert.equal(journal.status().available, false); assert.equal(journal.append('native.command', input), false);
        fs.rmSync(name, { force: true, recursive: true }); assert.equal(fs.readFileSync(target, 'utf8'), 'private-target');
    }
});
test('inactive rotation targets are revalidated before any append or overwrite', t => {
    const f = fixture(t, { maxFileBytes: 800 }); f.journal.append('native.command', input);
    const target = path.join(f.base, 'target'); fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, path.join(f.directory, 'diagnostics.4.jsonl'));
    assert.equal(f.journal.append('native.command', input), false);
    assert.equal(f.journal.snapshot().ok, false); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
test('root or profile replacement is detected even if the journal directory inode survives', t => {
    const f = fixture(t); f.journal.append('native.command', input);
    const previous = path.join(f.base, 'old-profile'); fs.renameSync(f.profile, previous); fs.mkdirSync(f.profile);
    fs.renameSync(path.join(previous, DIRECTORY), f.directory);
    assert.equal(f.journal.append('native.command', input), false); assert.equal(f.journal.status().errorCode, 'UNSAFE_PATH');
    const next = createPrivatePreviewJournal({ profile: f.profile });
    fs.renameSync(f.directory, path.join(f.profile, 'old-journal')); fs.mkdirSync(f.directory);
    assert.equal(next.append('native.command', input), false);
});
test('descriptor validation rejects a hardlink added between path validation and open', t => {
    let armed = false, target;
    const fsImpl = Object.assign(Object.create(fs), { openSync(name, ...args) {
        const fd = fs.openSync(name, ...args);
        if (armed && String(name).endsWith('diagnostics.0.jsonl')) { armed = false; fs.linkSync(name, target); }
        return fd;
    } });
    const f = fixture(t, { fsImpl }); target = path.join(f.base, 'linked'); armed = true;
    assert.equal(f.journal.append('native.command', input), false); assert.equal(fs.statSync(target).size, 0);
});
test('oversized on-disk members are rejected before allocating or reading their contents', t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'diagnostics.0.jsonl'), Buffer.alloc(MAX_FILE_BYTES + 1));
    let reads = 0;
    const journal = createPrivatePreviewJournal({ profile: f.profile, fsImpl: Object.assign(Object.create(fs), { readSync() { reads++; throw new Error(); } }) });
    assert.equal(journal.status().errorCode, 'FILE_TOO_LARGE'); assert.equal(journal.snapshot().ok, false); assert.equal(reads, 0);
});
test('export reprojects recognized records, excludes raw fields, and counts corrupt, blank and partial lines', t => {
    const f = fixture(t); f.journal.append('native.command', input);
    const record = f.journal.snapshot().records[0];
    const injected = { ...record, privateToken: 'secret-token', fields: { ...record.fields, path: '/private/file', payload: [1, 2, 3], errorCode: 'secret-message' } };
    fs.appendFileSync(path.join(f.directory, 'diagnostics.0.jsonl'), `${JSON.stringify(injected)}\n \n${'x'.repeat(8300)}\n{"token":"partial-secret"`);
    const snapshot = f.journal.snapshot(); assert.equal(snapshot.ok, true); assert.equal(snapshot.records.length, 2);
    assert.equal(snapshot.reprojectedRecords, 1); assert.equal(snapshot.rejectedRecords, 3);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|private\/file|payload|privateToken/);
});
test('build identity is immutable, canonical and ignores unknown values, references, getters and toJSON', () => {
    let calls = 0;
    const first = { appVersion: '0.7.12', buildId: '20261007', purpose: 'private-development-only', publicReleaseApproved: false,
        sourceHashes: { 'electron/main.cjs': 'a'.repeat(64), '/private/identity': 'b'.repeat(64) }, toJSON() { calls++; throw new Error(); } };
    Object.defineProperty(first, 'nodeVersion', { enumerable: true, get() { calls++; throw new Error(); } });
    const projected = projectBuildInfo(first), hash = buildReference(first);
    assert.equal(projectBuildInfo({ chromiumVersion: '150.0.7871.203' }).chromiumVersion, '150.0.7871.203');
    assert.deepEqual(projected.sourceHashes, { 'electron/main.cjs': 'a'.repeat(64) });
    assert.equal(buildReference({ ...projected, buildRef: 'c'.repeat(64), unknown: 'secret' }), hash);
    first.sourceHashes['electron/main.cjs'] = 'd'.repeat(64); assert.equal(projected.sourceHashes['electron/main.cjs'], 'a'.repeat(64));
    assert.ok(Object.isFrozen(projected)); assert.ok(Object.isFrozen(projected.sourceHashes)); assert.equal(calls, 0);
});
test('event projection and error classification read data descriptors without invoking caller getters', () => {
    let calls = 0;
    const fields = { ...input, path: 'secret', pcm: Buffer.from('private'), toJSON() { calls++; } };
    Object.defineProperty(fields, 'errorCode', { get() { calls++; return 'secret'; } });
    const event = projectEvent('native.command', fields); assert.deepEqual(event.fields, input); assert.equal(calls, 0);
    const error = {}; Object.defineProperty(error, 'code', { get() { calls++; return 'AUTH_REQUIRED'; } });
    assert.equal(sourceErrorCode(error), 'UNKNOWN'); assert.equal(calls, 0);
    assert.equal(projectEvent('renderer.native-error', { operation: 'play', errorCode: 'secret' }), null);
});
