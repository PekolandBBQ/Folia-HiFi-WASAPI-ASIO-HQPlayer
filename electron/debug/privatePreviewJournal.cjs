'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { own, projectEvent, projectRecord, projectBuildInfo, buildReference, runUuid } = require('./privatePreviewDiagnosticSchema.cjs');

// electron/debug/privatePreviewJournal.cjs — synchronous, bounded, main-only JSONL evidence.
const MAX_FILES = 5, MAX_FILE_BYTES = 1024 * 1024, MAX_RECORD_BYTES = 8192;
const DIRECTORY = 'diagnostics';
const FILE = /^diagnostics\.([0-4])\.jsonl$/;
const limit = (value, maximum, minimum) => Number.isSafeInteger(value) ? Math.max(minimum, Math.min(value, maximum)) : maximum;
const fail = code => Object.assign(new Error(code), { code });
// BigInt stat fields preserve Windows/large-filesystem identities above Number's exact integer range.
const identity = stat => `${stat.dev}:${stat.ino}`;
const safeFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n;
const safeDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.ino !== 0n;
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && value === path.resolve(value)
    && !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith('\\\\');

function createPrivatePreviewJournal({ profile, directory, buildInfo = {}, runId = randomUUID(), now = () => new Date(),
    maxFiles = MAX_FILES, maxFileBytes = MAX_FILE_BYTES, fsImpl = fs } = {}) {
    if (process.type === 'renderer') throw new Error('Private diagnostics require the main process');
    const retainedFiles = limit(maxFiles, MAX_FILES, 1), fileLimit = limit(maxFileBytes, MAX_FILE_BYTES, 256);
    const build = projectBuildInfo(buildInfo), buildRef = buildReference(build);
    const generatedRun = runUuid(runId) ? runId : randomUUID();
    let root = null, initialized = false, closed = false, compromised = false, lastError = null;
    let sequence = 0, fileCount = 0, totalBytes = 0;
    const counters = { recordCount: 0, droppedRecords: 0, writeErrors: 0, rejectedRecords: 0 };
    const ancestry = [], knownFiles = new Map();
    const count = key => { counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1); };
    const diagnose = error => {
        lastError = own(error, 'code') === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : own(error, 'code') === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : 'IO_FAILED';
        if (lastError === 'UNSAFE_PATH' || lastError === 'FILE_TOO_LARGE') compromised = true;
        count('writeErrors');
    };
    const filename = index => path.join(root, `diagnostics.${index}.jsonl`);
    const lstat = name => { try { return fsImpl.lstatSync(name, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

    // Witness every ancestor, including the trusted profile, before and after file opens.
    function initialize() {
        if (!validPath(profile) || profile === path.parse(profile).root) throw fail('UNSAFE_PATH');
        root = directory === undefined ? path.join(profile, DIRECTORY) : directory;
        if (!validPath(root) || root !== path.join(profile, DIRECTORY)) throw fail('UNSAFE_PATH');
        const parsed = path.parse(root), segments = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
        let current = parsed.root;
        for (const segment of ['', ...segments]) {
            if (segment) current = path.join(current, segment);
            let stat = lstat(current);
            if (!stat) {
                fsImpl.mkdirSync(current, { mode: 0o700 }); stat = fsImpl.lstatSync(current, { bigint: true });
            }
            if (!safeDirectory(stat)) throw fail('UNSAFE_PATH');
            ancestry.push([current, identity(stat)]);
        }
        validateAncestry();
        inspectFiles();
        // Lowered retention removes only fixed, validated members, never foreign logs.
        for (let index = retainedFiles; index < MAX_FILES; index++) {
            if (knownFiles.has(index)) { validateAncestry(); validateFile(index); fsImpl.unlinkSync(filename(index)); knownFiles.delete(index); }
        }
        refreshTotals(); initialized = true;
    }
    function validateAncestry() {
        for (const [name, expected] of ancestry) {
            const stat = lstat(name);
            if (!stat || !safeDirectory(stat) || identity(stat) !== expected) throw fail('UNSAFE_PATH');
        }
    }
    function validateFile(index, allowMissing = false) {
        const stat = lstat(filename(index)), expected = knownFiles.get(index);
        if (!stat) {
            if (expected || !allowMissing) throw fail('UNSAFE_PATH');
            return null;
        }
        if (!safeFile(stat) || (expected && identity(stat) !== expected)) throw fail('UNSAFE_PATH');
        if (stat.size > fileLimit) throw fail('FILE_TOO_LARGE');
        return stat;
    }
    function inspectFiles() {
        validateAncestry();
        for (let index = 0; index < MAX_FILES; index++) {
            const stat = validateFile(index, true);
            if (stat) knownFiles.set(index, identity(stat));
        }
    }
    function refreshTotals() {
        fileCount = 0; totalBytes = 0;
        for (let index = 0; index < retainedFiles; index++) {
            const stat = validateFile(index, true);
            if (stat) { fileCount++; totalBytes += Number(stat.size); }
        }
    }
    // O_NOFOLLOW and descriptor checks close the pathname-to-open link race.
    function openChecked(index, writable, create = false) {
        validateAncestry();
        const before = validateFile(index, create);
        const flags = (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW || 0)
            | (!before && create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
        const fd = fsImpl.openSync(filename(index), flags, 0o600);
        try {
            const stat = fsImpl.fstatSync(fd, { bigint: true });
            if (!safeFile(stat) || (before && identity(stat) !== identity(before))) throw fail('UNSAFE_PATH');
            if (stat.size > fileLimit) throw fail('FILE_TOO_LARGE');
            validateAncestry();
            const after = lstat(filename(index));
            if (!after || !safeFile(after) || identity(after) !== identity(stat)) throw fail('UNSAFE_PATH');
            knownFiles.set(index, identity(stat));
            return { fd, size: Number(stat.size), identity: identity(stat), created: !before };
        } catch (error) { try { fsImpl.closeSync(fd); } catch {} throw error; }
    }
    function syncDirectory() {
        // Some Windows filesystems do not expose a fsync-able directory handle.
        // File data is always fsynced; directory fsync is used where supported.
        if (process.platform === 'win32') return;
        const fd = fsImpl.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
        try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    }
    function rotate() {
        inspectFiles();
        for (let index = retainedFiles - 1; index >= 0; index--) {
            if (!knownFiles.has(index)) continue;
            validateAncestry(); validateFile(index);
            if (index === retainedFiles - 1) fsImpl.unlinkSync(filename(index));
            else {
                if (lstat(filename(index + 1))) throw fail('UNSAFE_PATH');
                fsImpl.renameSync(filename(index), filename(index + 1));
                knownFiles.set(index + 1, knownFiles.get(index));
            }
            knownFiles.delete(index);
        }
        syncDirectory(); refreshTotals();
    }
    function writeBytes(fd, buffer, start) {
        let written = 0;
        // Regular-file writes normally complete once; bounded retries handle short writes.
        for (let attempt = 0; written < buffer.length && attempt < 32; attempt++) {
            const size = fsImpl.writeSync(fd, buffer, written, buffer.length - written, start + written);
            if (!Number.isSafeInteger(size) || size <= 0 || size > buffer.length - written) throw fail('IO_FAILED');
            written += size;
        }
        if (written !== buffer.length) throw fail('IO_FAILED');
        fsImpl.fsyncSync(fd);
    }
    function append(type, fields) {
        if (!initialized || compromised || closed) { count('droppedRecords'); return false; }
        const event = projectEvent(type, fields);
        if (!event) { count('rejectedRecords'); return false; }
        let timestamp;
        try { const date = now(); timestamp = (date instanceof Date ? date : new Date(date)).toISOString(); }
        catch { count('rejectedRecords'); return false; }
        const record = { timestamp, sequence: sequence + 1, runId: generatedRun, buildRef, ...event };
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
        if (!projectRecord(record) || bytes.length > Math.min(MAX_RECORD_BYTES, fileLimit)) { count('rejectedRecords'); return false; }
        let opened;
        try {
            inspectFiles(); opened = openChecked(0, true, true);
            let prefix = false;
            if (opened.size) {
                const end = Buffer.alloc(1);
                if (fsImpl.readSync(opened.fd, end, 0, 1, opened.size - 1) !== 1) throw fail('IO_FAILED');
                prefix = end[0] !== 10;
            }
            if (opened.size + bytes.length + (prefix ? 1 : 0) > fileLimit) {
                fsImpl.closeSync(opened.fd); opened = null; rotate(); opened = openChecked(0, true, true); prefix = false;
            }
            validateAncestry(); validateFile(0);
            const payload = prefix ? Buffer.concat([Buffer.from('\n'), bytes]) : bytes;
            // A failed fsync can still leave a complete line: never reuse its run sequence.
            sequence = record.sequence;
            writeBytes(opened.fd, payload, opened.size);
            if (opened.created) syncDirectory();
            const after = fsImpl.fstatSync(opened.fd, { bigint: true });
            if (!safeFile(after) || identity(after) !== opened.identity || after.size > fileLimit) throw fail('UNSAFE_PATH');
            validateAncestry(); validateFile(0);
            count('recordCount'); lastError = null; refreshTotals(); return true;
        } catch (error) { diagnose(error); count('droppedRecords'); return false; }
        finally { if (opened) try { fsImpl.closeSync(opened.fd); } catch {} }
    }
    function readFile(index) {
        const opened = openChecked(index, false);
        try {
            const bytes = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < bytes.length) {
                const read = fsImpl.readSync(opened.fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
                if (!Number.isSafeInteger(read) || read <= 0) throw fail('IO_FAILED');
                offset += read;
            }
            const after = fsImpl.fstatSync(opened.fd, { bigint: true });
            if (!safeFile(after) || identity(after) !== opened.identity || Number(after.size) !== opened.size) throw fail('UNSAFE_PATH');
            validateAncestry(); validateFile(index); return bytes;
        } finally { fsImpl.closeSync(opened.fd); }
    }
    function snapshot() {
        if (!initialized || compromised || closed) return { ok: false, errorCode: lastError || 'UNAVAILABLE' };
        try {
            inspectFiles();
            const records = []; let rejectedRecords = 0, reprojectedRecords = 0;
            for (let index = retainedFiles - 1; index >= 0; index--) {
                if (!knownFiles.has(index)) continue;
                const bytes = readFile(index);
                let start = 0;
                for (let end = 0; end < bytes.length; end++) {
                    if (bytes[end] !== 10) continue;
                    const line = bytes.subarray(start, end); start = end + 1;
                    if (!line.length || line.length + 1 > MAX_RECORD_BYTES) { rejectedRecords++; continue; }
                    let parsed, safe;
                    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); safe = projectRecord(parsed); }
                    catch { rejectedRecords++; continue; }
                    if (!safe) { rejectedRecords++; continue; }
                    if (JSON.stringify(safe) !== JSON.stringify(parsed)) reprojectedRecords++;
                    records.push(safe);
                }
                if (start !== bytes.length) rejectedRecords++;
            }
            return { ok: true, records, rejectedRecords, reprojectedRecords, buildInfo: build,
                buildRef, buildInfoScope: 'matching-build-ref-only' };
        } catch (error) { diagnose(error); return { ok: false, errorCode: lastError }; }
    }
    try { initialize(); } catch (error) { diagnose(error); }
    return Object.freeze({
        append, record: append, snapshot,
        get directory() { return initialized && !compromised ? root : null; },
        validateDirectory() { try { if (!initialized || compromised || closed) return false; inspectFiles(); return true; } catch (error) { diagnose(error); return false; } },
        status() { return { available: initialized && !compromised && !closed, recording: initialized && !compromised && !closed,
            runId: generatedRun, buildRef, ...counters, fileCount, totalBytes, maxFiles: retainedFiles, maxFileBytes: fileLimit,
            ...(lastError ? { errorCode: lastError } : {}) }; },
        close() { closed = true; },
    });
}
module.exports = { createPrivatePreviewJournal, MAX_FILES, MAX_FILE_BYTES, MAX_RECORD_BYTES, DIRECTORY, FILE };
