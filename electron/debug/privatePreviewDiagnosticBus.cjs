'use strict';
const { projectEvent, sourceErrorCode } = require('./privatePreviewDiagnosticSchema.cjs');

// electron/debug/privatePreviewDiagnosticBus.cjs — main-only, inert until the private entry installs a sink.
let sink = null, nextSession = 0, nextOperation = 0;
const references = new Map(), playlistReferences = new Map();
const MAX_SESSIONS = 256;
function isPreviewDiagnosticsEnabled() {
    try { return process.type !== 'renderer' && sink !== null && sink.enabled() === true; } catch { return false; }
}
function publishPreviewDiagnostic(type, fields) {
    if (!isPreviewDiagnosticsEnabled()) return false;
    try { const projected = projectEvent(type, fields); return projected ? sink.record(projected.type, projected.fields) : false; } catch { return false; }
}
function previewSessionRef(session) {
    if (!isPreviewDiagnosticsEnabled() || session == null || (typeof session !== 'string' && typeof session !== 'number' && typeof session !== 'object')) return undefined;
    if (typeof session === 'string' && session.length > 256) return undefined;
    if (references.has(session)) {
        const ref = references.get(session); references.delete(session); references.set(session, ref); return ref;
    }
    if (nextSession >= 2147483647) return undefined;
    if (references.size >= MAX_SESSIONS) references.delete(references.keys().next().value);
    const ref = ++nextSession; references.set(session, ref); return ref;
}
// A playlist reference must remain stable across cache/API/public observations in this run.
// Stop assigning after the cap instead of evicting and silently assigning a second identity.
function previewPlaylistDiagnosticRef(id) {
    if (!isPreviewDiagnosticsEnabled() || typeof id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(id)) return undefined;
    if (playlistReferences.has(id)) return playlistReferences.get(id);
    if (playlistReferences.size >= MAX_SESSIONS || nextSession >= 2147483647) return undefined;
    const ref = ++nextSession; playlistReferences.set(id, ref); return ref;
}
function releasePreviewSession(session) { references.delete(session); }
function previewOperationRef() { return isPreviewDiagnosticsEnabled() && nextOperation < 2147483647 ? ++nextOperation : undefined; }
function installPreviewDiagnosticSink(next) {
    if (process.type === 'renderer') throw new Error('Private diagnostics require the main process');
    if (!next || typeof next.enabled !== 'function' || typeof next.record !== 'function' || sink) throw new Error('Private diagnostic sink unavailable');
    sink = next; nextSession = 0; nextOperation = 0; references.clear(); playlistReferences.clear();
    return () => { if (sink === next) { sink = null; references.clear(); playlistReferences.clear(); nextSession = 0; nextOperation = 0; } };
}
const diagnosticBus = Object.freeze({
    get enabled() { return isPreviewDiagnosticsEnabled(); }, record: publishPreviewDiagnostic,
    sessionRef: previewSessionRef, releaseSession: releasePreviewSession,
});
module.exports = { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef, previewPlaylistDiagnosticRef, previewOperationRef, releasePreviewSession, installPreviewDiagnosticSink, sourceErrorCode, diagnosticBus };
