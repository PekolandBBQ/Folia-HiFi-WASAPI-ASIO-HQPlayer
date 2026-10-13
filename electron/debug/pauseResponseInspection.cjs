'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isPreviewDiagnosticsEnabled } = require('./privatePreviewDiagnosticBus.cjs');

// One explicitly armed, local-only pause response inspection. Never part of the diagnostic bus or ZIP.
const DIRECTORY = 'private-pause-inspection', MAX_BODY_BYTES = 128, MAX_REPORT_BYTES = 1024;
let active;
// A controller may close or be installed again, but the same main process never gets a second arm attempt.
const attemptedProcesses = new WeakSet();
const safeDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.ino !== 0n;
const safeFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n;
const identity = stat => `${stat.dev}:${stat.ino}`;

function candidateFilter(text) {
  // This is local-review triage, not certification for export. A reviewer must still inspect the exact text.
  if (/[0-9@\\/]|www\.|\b(?:authorization|bearer|token|cookie|password|secret|credential|session|account|profile|username|userid|api[- ]?key)\b/i.test(text)
    || /[A-Za-z_-]{24,}/.test(text)) return 'blocked-sensitive-marker';
  if (!/^[A-Za-z \t\r\n.,!:'()-]+$/.test(text)
    || !/\b(?:pause|paused|pausing|playback|player|command|request|success|successful|successfully|error|failed|failure|accepted|forbidden|unauthorized|denied)\b/i.test(text)
    || (text.match(/[A-Za-z]+/g) || []).some(word => word.length > 20)) return 'blocked-unrecognized';
  return 'local-review-required';
}

function installPauseResponseInspection({ profile, armed = false, enabled = () => false, fsImpl = fs, processObject = process } = {}) {
  let closed = false, used = false, attempted = false, state = 'idle', queued, filename, ancestry;
  const allowed = () => {
    try { return !closed && process.type !== 'renderer' && enabled() === true && isPreviewDiagnosticsEnabled(); }
    catch { return false; }
  };
  const status = () => allowed() && (attempted || !attemptedProcesses.has(processObject)) ? state : 'unavailable';
  const validate = () => ancestry.every(([name, expected]) => {
    const stat = fsImpl.lstatSync(name, { bigint: true });
    return safeDirectory(stat) && identity(stat) === expected;
  });
  // Reserve this process's single attempt before checking or creating the fixed local destination.
  function arm() {
    if (!allowed()) return 'unavailable';
    if (attempted) return state;
    if (active || !processObject || !['object', 'function'].includes(typeof processObject)
      || attemptedProcesses.has(processObject)) return (state = 'unavailable');
    attempted = true; attemptedProcesses.add(processObject); state = 'failed';
    try {
      if (typeof profile !== 'string' || !path.isAbsolute(profile) || profile !== path.resolve(profile)
        || profile === path.parse(profile).root || /[\x00-\x1f\x7f]/.test(profile) || profile.startsWith('\\\\')) return state;
      const directory = path.join(profile, DIRECTORY);
      ancestry = [];
      for (let current = profile; ; current = path.dirname(current)) {
        const stat = fsImpl.lstatSync(current, { bigint: true });
        if (!safeDirectory(stat)) return state;
        ancestry.push([current, identity(stat)]);
        if (current === path.dirname(current)) break;
      }
      try { fsImpl.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return state; }
      const stat = fsImpl.lstatSync(directory, { bigint: true });
      if (!safeDirectory(stat)) return state;
      ancestry.push([directory, identity(stat)]);
      filename = path.join(directory, `pause-${randomUUID()}.json`);
      if (!allowed() || !validate()) return state;
      state = 'armed'; active = inspect;
    } catch { /* Arming errors stay local, consume the attempt, and expose only a fixed state. */ }
    return status();
  }
  const inspect = value => {
    if (state !== 'armed' || used || !allowed() || !(value instanceof Uint8Array)
      || value.byteLength < 1 || value.byteLength > MAX_BODY_BYTES) return false;
    used = true;
    const bytes = Buffer.from(value);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
    const utf8Valid = text !== undefined, hasBom = utf8Valid && text.startsWith('\uFEFF');
    const ascii = utf8Valid && /^[\x00-\x7f]*$/.test(text);
    const hasControl = utf8Valid && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text);
    const filter = !utf8Valid || hasBom || !ascii || hasControl ? 'quarantined-nontext' : candidateFilter(text);
    // Exact bytes remain in this separate local quarantine. Never read bodyBase64 into ordinary diagnostics or upload it.
    let report = { schemaVersion: 1, endpoint: 'playback-pause', httpStatus: 200, bodyBytes: bytes.length,
      bodyEncoding: 'base64', utf8Valid, hasBom, ascii, hasControl, filter, bodyBase64: bytes.toString('base64'),
      ...(filter === 'local-review-required' ? { localCandidate: text } : {}) };
    // Do not extend the request deadline or propagate inspection I/O errors into playback.
    queued = setImmediate(() => {
      queued = undefined;
      let fd, committed = false;
      try {
        if (!allowed() || !validate()) return;
        const bytes = Buffer.from(JSON.stringify(report) + '\n');
        if (bytes.length > MAX_REPORT_BYTES) return;
        fd = fsImpl.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const opened = fsImpl.fstatSync(fd, { bigint: true });
        const named = fsImpl.lstatSync(filename, { bigint: true });
        if (!allowed() || !safeFile(opened) || !safeFile(named) || identity(opened) !== identity(named) || !validate()) return;
        // One bounded regular-file write; a short or failed write is never retried as another capture.
        if (fsImpl.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !allowed()) return;
        fsImpl.fsyncSync(fd);
        const final = fsImpl.fstatSync(fd, { bigint: true }), selected = fsImpl.lstatSync(filename, { bigint: true });
        if (!allowed() || !safeFile(final) || !safeFile(selected) || identity(final) !== identity(opened)
          || identity(final) !== identity(selected) || final.size !== BigInt(bytes.length) || !validate()) return;
        committed = true;
      } catch { /* Inspection never changes playback or exposes the filesystem error. */ }
      finally {
        report = undefined;
        if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { committed = false; } }
        // Closing/revoking during any I/O callback cannot acknowledge a completed capture.
        state = committed && allowed() ? 'captured' : 'failed';
      }
    });
    return true;
  };
  const close = () => { closed = true; if (queued) { clearImmediate(queued); queued = undefined; } if (active === inspect) active = undefined; };
  // Keep the existing disposer contract for the explicitly armed legacy entry.
  Object.assign(close, { arm, status });
  if (armed === true) arm();
  return Object.freeze(close);
}

function inspectRejectedPauseResponse(bytes) {
  try { return active?.(bytes) === true; } catch { return false; }
}

module.exports = { installPauseResponseInspection, inspectRejectedPauseResponse, DIRECTORY, MAX_BODY_BYTES, MAX_REPORT_BYTES };
