'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

// Main-only bounded diagnostics. Time/daemon/URI association is evidence, not
// a FileStreamer identity, per-frame codec binding or source bit-depth claim.
const LEVELS = new Set(['standard', 'high', 'lossless']);
const CODECS = new Set(['FLAC_FLAC_24BIT', 'OGG_VORBIS', 'FLAC', 'VORBIS', 'AAC', 'OPUS', 'MP3', 'PCM']);
const fail = code => Object.assign(new Error(`Spotify diagnostics: ${code}`), { code });
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validDaemon(value) {
  return keys(value, 'pid,startTicks,uid') && integer(value.pid) && value.pid > 0
    && integer(value.uid) && typeof value.startTicks === 'string' && /^\d{1,20}$/.test(value.startTicks);
}
function validMarker(value) {
  return keys(value, 'daemon,fileIdentity,monotonic,offset,requestedQuality,unixMs')
    && LEVELS.has(value.requestedQuality) && validDaemon(value.daemon) && integer(value.offset)
    && finite(value.monotonic) && integer(value.unixMs) && value.unixMs > 0
    && (value.fileIdentity === null || (keys(value.fileIdentity, 'device,inode')
      && integer(value.fileIdentity.device) && integer(value.fileIdentity.inode)));
}
function validEvidence(value, marker, uri) {
  if (!keys(value, 'association,events,incompleteFinalLine,observedDaemon,observedUri,requestedQuality,sourceBitDepth,sourceEncodingVerified,sourceQuality,truncated,window')
    || value.requestedQuality !== marker.requestedQuality || value.observedUri !== uri
    || !validDaemon(value.observedDaemon) || ['pid', 'startTicks', 'uid'].some(key => value.observedDaemon[key] !== marker.daemon[key])
    || value.sourceBitDepth !== null || value.sourceQuality !== null || value.sourceEncodingVerified !== false
    || typeof value.truncated !== 'boolean' || typeof value.incompleteFinalLine !== 'boolean'
    || !keys(value.association, 'currentUriVerified,daemonLifecycle,fileStreamerIdentity,perFrame,timeWindow')
    || value.association.timeWindow !== true || value.association.daemonLifecycle !== true
    || value.association.currentUriVerified !== true || value.association.fileStreamerIdentity !== false
    || value.association.perFrame !== false
    || !keys(value.window, 'collectedUnixMs,markUnixMs,sinceMonotonic,untilMonotonic')
    || value.window.sinceMonotonic !== marker.monotonic || value.window.markUnixMs !== marker.unixMs
    || !finite(value.window.untilMonotonic) || value.window.untilMonotonic < marker.monotonic
    || value.window.untilMonotonic - marker.monotonic > 300 || !integer(value.window.collectedUnixMs)
    || !Array.isArray(value.events) || value.events.length > 256) return false;
  return value.events.every(row => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => ['monotonic', 'kind', 'codec', 'sampleRate', 'averageBitrateDiagnostic'].includes(key))
    && finite(row.monotonic) && row.monotonic >= marker.monotonic && row.monotonic <= value.window.untilMonotonic
    && ['renderer', 'file_streamer', 'audio_other'].includes(row.kind)
    && (row.codec === undefined || CODECS.has(row.codec))
    && (row.sampleRate === undefined || (integer(row.sampleRate) && row.sampleRate >= 8000 && row.sampleRate <= 768000))
    && (row.averageBitrateDiagnostic === undefined || (finite(row.averageBitrateDiagnostic)
      && row.averageBitrateDiagnostic > 0 && row.averageBitrateDiagnostic <= 100000000)));
}
function createSoloistCodecDiagnostics({ plan, spawnProcess = spawn, readPublicFile = fs.readFileSync, timeoutMs = 30000 } = {}) {
  if (process.type === 'renderer' || !plan || typeof plan.assertApplianceLease !== 'function' || !plan.expectedLease
    || !['sshExecutablePath', 'keyPath', 'knownHostsPath'].every(key => typeof plan[key] === 'string'
      && path.win32.isAbsolute(plan[key]) && !/[\r\n\0]/.test(plan[key]))
    || !/^[a-f0-9]{64}$/.test(plan.guestPlanSha256 || '') || !/^[a-f0-9]{64}$/.test(plan.sshExecutableSha256 || '')
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw fail('INVALID_REQUEST');
  const approved = Object.freeze({ ...plan, expectedLease: Object.freeze({ ...plan.expectedLease }) });
  async function lease() {
    let current;
    try { current = await approved.assertApplianceLease(); } catch { throw fail('APPLIANCE_UNAVAILABLE'); }
    if (!current || Object.keys(approved.expectedLease).some(key => current[key] !== approved.expectedLease[key])
      || createHash('sha256').update(readPublicFile(approved.sshExecutablePath)).digest('hex') !== approved.sshExecutableSha256)
      throw fail('APPLIANCE_UNAVAILABLE');
  }
  async function invoke(request, { signal } = {}) {
    if (signal?.aborted) throw fail('CANCELLED');
    await lease(); if (signal?.aborted) throw fail('CANCELLED');
    const bytes = await new Promise((resolve, reject) => {
      let child, timer, length = 0, settled = false; const blocks = [];
      const finish = (error, output) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) child?.kill(); for (const block of blocks) block.fill(0);
        if (error) reject(error); else resolve(output);
      };
      const abort = () => finish(fail('CANCELLED'));
      const args = ['-i', approved.keyPath, '-p', '22821', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${approved.knownHostsPath}`, 'root@127.0.0.1',
        `/opt/folia/venv/bin/python -I /opt/folia/read-codec-diagnostics.py --approved-plan-sha256=${approved.guestPlanSha256}`];
      try { child = spawnProcess(approved.sshExecutablePath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { finish(fail('APPLIANCE_UNAVAILABLE')); return; }
      child.on('error', () => finish(fail('APPLIANCE_UNAVAILABLE')));
      child.stdin.on('error', () => finish(fail('APPLIANCE_UNAVAILABLE')));
      child.stdout.on('data', output => {
        if (settled) return; length += output.length;
        if (length > 131072) finish(fail('DIAGNOSTIC_PROTOCOL_INVALID')); else blocks.push(Buffer.from(output));
      });
      child.on('close', code => {
        if (settled) return;
        const output = Buffer.concat(blocks, length);
        if (code !== 0) {
          let publicCode;
          try {
            const value = JSON.parse(output.toString('utf8'));
            if (keys(value, 'code,ok') && value.ok === false && /^[A-Z_]{1,80}$/.test(value.code)) publicCode = value.code;
          } catch { /* Raw output is never returned. */ } finally { output.fill(0); }
          finish(fail(publicCode || 'DIAGNOSTIC_READ_FAILED'));
        } else finish(null, output);
      });
      timer = setTimeout(() => finish(fail('CONTROL_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.end(JSON.stringify(request));
    });
    try {
      await lease(); if (signal?.aborted) throw fail('CANCELLED');
      let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('DIAGNOSTIC_PROTOCOL_INVALID'); }
      if (!keys(value, 'ok,result') || value.ok !== true) throw fail('DIAGNOSTIC_PROTOCOL_INVALID');
      const result = value.result;
      if (!(request.operation === 'mark' ? validMarker(result) && result.requestedQuality === request.requestedQuality
        : validEvidence(result, request.marker, request.expectedUri))) throw fail('DIAGNOSTIC_PROTOCOL_INVALID');
      return Object.freeze(result);
    } finally { bytes.fill(0); }
  }
  return Object.freeze({
    mark(requestedQuality, options) {
      if (!LEVELS.has(requestedQuality)) return Promise.reject(fail('INVALID_REQUEST'));
      return invoke({ operation: 'mark', requestedQuality }, options);
    },
    readSince(marker, expectedUri, options) {
      if (!validMarker(marker) || typeof expectedUri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(expectedUri))
        return Promise.reject(fail('INVALID_REQUEST'));
      return invoke({ operation: 'readSince', marker, expectedUri }, options);
    },
  });
}
module.exports = { createSoloistCodecDiagnostics };
