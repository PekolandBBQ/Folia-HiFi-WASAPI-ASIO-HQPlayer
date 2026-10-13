'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPrivatePreviewJournal, MAX_FILES, MAX_FILE_BYTES } = require('./privatePreviewJournal.cjs');
const { installPreviewDiagnosticSink } = require('./privatePreviewDiagnosticBus.cjs');
const { own, projectEvent, projectBuildInfo, RENDERER_EVENTS } = require('./privatePreviewDiagnosticSchema.cjs');
const { projectRendererLibrary } = require('../spotify/playlistCatalogDiagnostics.cjs');
const { installPauseResponseInspection } = require('./pauseResponseInspection.cjs');

// electron/debug/privatePreviewDiagnostics.cjs — explicit private entry installation and local-only export.
const IPC_CHANNEL = 'private-preview-diagnostics:request';
const STABLE_SAMPLES = new Set(['native.progress', 'native.state', 'native.format', 'spotify.auth', 'spotify.auth-read', 'spotify.state']);
const reason = value => ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'].includes(value) ? value : 'unknown';
const kind = value => ['GPU', 'Utility', 'Zygote', 'SandboxHelper', 'PepperPlugin', 'PepperPluginBroker'].includes(value) ? value : 'unknown';

// The chosen export destination never accepts a redirecting file or ancestor.
function saveArchive(filename, bytes, fsImpl = fs) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename !== path.resolve(filename)
        || /[\x00-\x1f\x7f]/.test(filename) || path.extname(filename).toLowerCase() !== '.zip') throw new Error('EXPORT_FAILED');
    const ancestry = []; let current = path.dirname(filename);
    while (true) {
        const stat = fsImpl.lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino) throw new Error('EXPORT_FAILED');
        ancestry.push([current, stat.dev, stat.ino]);
        if (current === path.dirname(current)) break;
        current = path.dirname(current);
    }
    const validate = () => {
        for (const [entry, dev, ino] of ancestry) {
            const stat = fsImpl.lstatSync(entry, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino) throw new Error('EXPORT_FAILED');
        }
    };
    let before;
    try { before = fsImpl.lstatSync(filename, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !before.ino)) throw new Error('EXPORT_FAILED');
    const fd = fsImpl.openSync(filename, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
        | (!before ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o600);
    try {
        const opened = fsImpl.fstatSync(fd, { bigint: true }), named = fsImpl.lstatSync(filename, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !opened.ino || opened.dev !== named.dev || opened.ino !== named.ino
            || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) throw new Error('EXPORT_FAILED');
        validate(); fsImpl.ftruncateSync(fd, 0);
        let at = 0;
        for (let attempt = 0; at < bytes.length && attempt < 32; attempt++) {
            const written = fsImpl.writeSync(fd, bytes, at, bytes.length - at, at);
            if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - at) throw new Error('EXPORT_FAILED');
            at += written;
        }
        if (at !== bytes.length) throw new Error('EXPORT_FAILED');
        fsImpl.fsyncSync(fd); validate();
        const final = fsImpl.fstatSync(fd, { bigint: true }), selected = fsImpl.lstatSync(filename, { bigint: true });
        if (!final.isFile() || final.nlink !== 1n || selected.isSymbolicLink() || final.dev !== selected.dev || final.ino !== selected.ino)
            throw new Error('EXPORT_FAILED');
    } finally { fsImpl.closeSync(fd); }
}

function installPrivatePreviewDiagnostics({ app, ipcMain, dialog, shell, profile, rendererEntry, buildInfo = {},
    getMainWindow, isTrustedSender, enabled = true, processObject = process, now = () => new Date(),
    clock = () => Date.now(), journalOptions = {}, zip = files => require('fflate').zipSync(files, { level: 6 }) } = {}) {
    if (process.type === 'renderer') throw new Error('Private diagnostics require the main process');
    let journal = null, busy = false, closed = false, started = false, rejectionObserver = null, pauseInspection;
    let exportedArchives = 0, exportErrors = 0;
    const projectedBuild = projectBuildInfo(buildInfo), samples = new Map(), listeners = [];
    const expectedUrl = typeof rendererEntry === 'string' && path.isAbsolute(rendererEntry) ? pathToFileURL(rendererEntry).href : rendererEntry;
    const ownsLock = () => { try { return enabled === true && !closed && app.hasSingleInstanceLock() === true; } catch { return false; } };
    function ensureJournal() {
        if (!ownsLock()) return null;
        if (!journal) journal = createPrivatePreviewJournal({ ...journalOptions, profile, buildInfo: projectedBuild, now });
        if (!started) {
            started = true;
            pauseInspection = installPauseResponseInspection({ profile, enabled: ownsLock, processObject,
                armed: processObject.env?.FOLIA_PRIVATE_PAUSE_RESPONSE_INSPECTION === '1' });
            journal.append('run.start', { platform: process.platform, arch: process.arch, packaged: app.isPackaged === true,
                appVersion: projectedBuild.appVersion, electronVersion: projectedBuild.electronVersion,
                buildId: projectedBuild.buildId, soloistManifestSha256: projectedBuild.soloistManifestSha256 });
        }
        return journal;
    }
    function record(type, fields) {
        if (!ownsLock()) return false;
        const projected = projectEvent(type, fields);
        if (!projected) return ensureJournal()?.append(type, fields) || false;
        if (STABLE_SAMPLES.has(type) && !Object.hasOwn(projected.fields, 'errorCode') && projected.fields.ok !== false) {
            let time;
            try { time = clock(); } catch { return false; }
            if (!Number.isFinite(time)) return false;
            const key = `${type}:${projected.fields.sessionRef ?? 0}:${projected.fields.phase ?? ''}:${projected.fields.layer ?? ''}:${projected.fields.command ?? ''}:${projected.fields.formatStage ?? ''}`;
            const stable = { ...projected.fields };
            for (const field of ['positionSeconds', 'durationSeconds', 'bufferedStart', 'bufferedEnd', 'elapsedMs', 'loaded', 'total', 'observation', 'operationRef']) delete stable[field];
            const signature = JSON.stringify(stable), previous = samples.get(key);
            if (previous && previous.signature === signature && time >= previous.time && time - previous.time < 1000) return false;
            if (samples.size >= 512 && !samples.has(key)) samples.delete(samples.keys().next().value);
            samples.set(key, { time, signature });
        }
        return ensureJournal()?.append(projected.type, projected.fields) || false;
    }
    function status() {
        const current = ensureJournal();
        return { enabled: enabled === true && !closed, available: false, recording: false, recordCount: 0, fileCount: 0, totalBytes: 0,
            maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, droppedRecords: 0, writeErrors: 0, rejectedRecords: 0,
            ...(current ? current.status() : {}), busy, exportedArchives, exportErrors,
            pauseResponseInspection: pauseInspection?.status() ?? 'unavailable' };
    }
    function armPauseResponseInspection() {
        ensureJournal();
        const state = pauseInspection?.arm() ?? 'unavailable';
        const ok = state === 'armed' || state === 'captured';
        return { ok, pauseResponseInspection: state,
            ...(!ok ? { errorCode: state === 'failed' ? 'INSPECTION_FAILED' : 'UNAVAILABLE' } : {}) };
    }
    function trusted(event) {
        try {
            if (!event?.sender || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed?.()) return false;
            if (isTrustedSender && !isTrustedSender(event.sender)) return false;
            const window = getMainWindow?.();
            if (getMainWindow && (!window || window.isDestroyed?.() || window.webContents !== event.sender)) return false;
            if (typeof expectedUrl !== 'string') return false;
            const url = new URL(expectedUrl);
            if (!(url.protocol === 'file:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return false;
            const actualUrl = event.senderFrame.url;
            const exactEntry = actualUrl === expectedUrl;
            // loadAppEntry disables its splash for transparent/wallpaper windows with this one fixed query.
            const transparentEntry = url.protocol === 'file:' && !url.search && !url.hash && actualUrl === `${expectedUrl}?splash=0`;
            return (exactEntry || transparentEntry) && event.sender.getURL() === actualUrl;
        } catch { return false; }
    }
    async function openFolder() {
        const current = ensureJournal();
        if (!ownsLock() || !current?.validateDirectory()) return { ok: false, errorCode: 'UNAVAILABLE' };
        try { const error = await shell.openPath(current.directory); return error ? { ok: false, errorCode: 'OPEN_FAILED' } : { ok: true }; }
        catch { return { ok: false, errorCode: 'OPEN_FAILED' }; }
    }
    async function exportArchive() {
        if (busy) return { ok: false, busy: true, errorCode: 'BUSY' };
        const current = ensureJournal();
        if (!ownsLock() || !current?.validateDirectory()) return { ok: false, errorCode: 'UNAVAILABLE' };
        busy = true;
        try {
            const options = { title: 'Export private preview diagnostics', defaultPath: 'Folia-private-preview-diagnostics.zip',
                filters: [{ name: 'ZIP archive', extensions: ['zip'] }] };
            const owner = getMainWindow?.();
            const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
            if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
            if (!ownsLock()) return { ok: false, errorCode: 'UNAVAILABLE' };
            const snapshot = current.snapshot();
            if (!snapshot.ok) throw new Error('EXPORT_FAILED');
            // No legacy log, user profile, crash text, raw IPC, account or audio data enters this archive.
            const files = {
                'diagnostics.jsonl': Buffer.from(snapshot.records.map(item => JSON.stringify(item)).join('\n') + (snapshot.records.length ? '\n' : '')),
                'build-info.json': Buffer.from(JSON.stringify({ buildRef: snapshot.buildRef, buildInfoScope: snapshot.buildInfoScope, buildInfo: snapshot.buildInfo }, null, 2)),
                'export-info.json': Buffer.from(JSON.stringify({ schemaVersion: 1, recordCount: snapshot.records.length,
                    rejectedRecords: snapshot.rejectedRecords, reprojectedRecords: snapshot.reprojectedRecords,
                    maxFiles: current.status().maxFiles, maxFileBytes: current.status().maxFileBytes }, null, 2)),
            };
            const bytes = Buffer.from(zip(files));
            if (bytes.length > MAX_FILES * MAX_FILE_BYTES + 65536) throw new Error('EXPORT_FAILED');
            saveArchive(selected.filePath, bytes);
            exportedArchives = Math.min(Number.MAX_SAFE_INTEGER, exportedArchives + 1); return { ok: true };
        } catch { exportErrors = Math.min(Number.MAX_SAFE_INTEGER, exportErrors + 1); return { ok: false, errorCode: 'EXPORT_FAILED' }; }
        finally { busy = false; }
    }
    const unbind = installPreviewDiagnosticSink({ enabled: ownsLock, record });
    const listen = (emitter, name, handler) => { emitter.on(name, handler); listeners.push([emitter, name, handler]); };
    listen(app, 'ready', () => { ensureJournal(); });
    listen(app, 'before-quit', () => record('process.termination', { kind: 'main', reason: 'before-quit' }));
    listen(app, 'will-quit', () => record('process.termination', { kind: 'main', reason: 'will-quit' }));
    listen(app, 'render-process-gone', (_event, _contents, details) => record('process.termination', { kind: 'renderer', reason: reason(own(details, 'reason')), exitCode: own(details, 'exitCode') }));
    listen(app, 'child-process-gone', (_event, details) => record('process.termination', { kind: kind(own(details, 'type')), reason: reason(own(details, 'reason')), exitCode: own(details, 'exitCode') }));
    // A monitor does not suppress Node's fatal exception policy or replace the app's handlers.
    listen(processObject, 'uncaughtExceptionMonitor', () => record('process.termination', { kind: 'main', reason: 'uncaught-exception' }));
    listen(processObject, 'exit', code => record('process.termination', { kind: 'main', reason: 'exit', exitCode: code }));
    function observeExistingRejectionHandler() {
        if (rejectionObserver || processObject.listenerCount('unhandledRejection') === 0) return false;
        rejectionObserver = () => record('process.termination', { kind: 'main', reason: 'unhandled-rejection' });
        listen(processObject, 'unhandledRejection', rejectionObserver);
        // If the app removes its final handler, our observer must not become a new rejection policy.
        listen(processObject, 'removeListener', name => {
            if (name !== 'unhandledRejection' || !rejectionObserver) return;
            if (processObject.listeners(name).every(handler => handler === rejectionObserver)) {
                const previous = rejectionObserver; rejectionObserver = null; processObject.removeListener(name, previous);
            }
        });
        return true;
    }
    ipcMain.handle(IPC_CHANNEL, async (event, request) => {
        if (!trusted(event)) return { ok: false, errorCode: 'UNTRUSTED_CALLER' };
        const action = own(request, 'action');
        if (action === 'status') return status();
        if (action === 'armPauseResponseInspection') return armPauseResponseInspection();
        if (action === 'openFolder') return openFolder();
        if (action === 'export') return exportArchive();
        if (action === 'record') {
            const type = own(request, 'event');
            if (!RENDERER_EVENTS.includes(type)) return { ok: false, errorCode: 'INVALID_REQUEST' };
            const fields = type === 'spotify.library' ? projectRendererLibrary(own(request, 'fields')) : own(request, 'fields');
            return { ok: fields !== null && record(type, fields) };
        }
        return { ok: false, errorCode: 'INVALID_REQUEST' };
    });
    return Object.freeze({ record, status, openFolder, export: exportArchive, observeExistingRejectionHandler,
        close() {
            if (closed) return; record('run.end', { reason: 'normal' }); closed = true;
            pauseInspection?.(); unbind(); for (const [emitter, name, listener] of listeners) emitter.removeListener(name, listener);
            ipcMain.removeHandler?.(IPC_CHANNEL); journal?.close(); samples.clear();
        },
    });
}
module.exports = { installPrivatePreviewDiagnostics, saveArchive, IPC_CHANNEL };
