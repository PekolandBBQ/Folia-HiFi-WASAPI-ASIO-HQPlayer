'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { projectSoloistAuthDiagnostic } = require('./soloistAuthDiagnostics.cjs');
const { createSoloistAuthReadObserver } = require('./soloistAuthReadObserver.cjs');
const { isPreviewDiagnosticsEnabled, publishPreviewDiagnostic } = require('../debug/privatePreviewDiagnosticBus.cjs');

// Trusted main composition for an owned clean QEMU instance. Its channel is
// derived anew from the owner, never from renderer input or discovery names.
const fail = code => Object.assign(new Error(`Spotify appliance: ${code}`), { code });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value)) && !/[\x00-\x1f\x7f"]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const port = value => integer(value) && value > 0 && value < 65536;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === expected;
const uri = value => typeof value === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(value);
const ownerTag = value => typeof value === 'string' && /^\d{1,20}(?::\d{1,20}){6}:[a-f0-9]{64}$/.test(value);
const OWNER_KEYS = 'executableDevice,executableInode,executableSha256,pid,startTicks,uid,wsPort,wsSocketPid,wsSocketStartTicks,zeroConfPort,zeroConfSocketPid,zeroConfSocketStartTicks';
const PUBLIC_CODES = new Set(`INVALID_REQUEST PROTOCOL_INVALID SOLOIST_ASSET_UNVERIFIED SOLOIST_ASSET_MISMATCH
  APPLIANCE_USER_REQUIRED PROCESS_UNAVAILABLE SOCKET_SCAN_INCOMPLETE SOLOIST_BINARY_INVALID SOLOIST_BINARY_CHANGED
  SOCKET_OWNER_MISMATCH SOCKET_OWNER_AMBIGUOUS MA_ANCESTRY_MISMATCH MA_OWNER_CHANGED SOLOIST_PROCESS_MISMATCH
  OWNER_CHANGED MA_DATA_UNAVAILABLE SOLOIST_CONTROL_AMBIGUOUS SOLOIST_CONTROL_UNSAFE MA_SERVICE_UNAVAILABLE
  PLAYBACK_SCHEMA_INVALID AUTH_OR_ACTIVE_CHANGED PAUSED_TEST_REQUIRED TRACK_CHANGED EXTERNAL_POSITION_CHANGED
  POSITION_INVALID SOLOIST_INSTALL_REQUIRED SOLOIST_STARTING ZC_RESPONSE_TOO_LARGE ZC_CONTROL_UNAVAILABLE
  AUTH_SCHEMA_INVALID PLAYBACK_UNAVAILABLE WS_COMMAND_REJECTED COMMAND_UNAVAILABLE COMMAND_TIMEOUT
  RESPONSE_TOO_LARGE OWNED_CONTROL_UNAVAILABLE OWNED_CONTROL_TIMEOUT CODEC_DIAGNOSTICS_UNAVAILABLE INVALID_DIAGNOSTICS
  DIAGNOSTIC_APPLIANCE_CHANGED DIAGNOSTIC_OWNER_INVALID DIAGNOSTIC_AUTH_REQUIRED DIAGNOSTIC_DAEMON_CHANGED
  DIAGNOSTIC_TRACK_CHANGED DIAGNOSTIC_WINDOW_EXPIRED DIAGNOSTIC_FILE_CHANGED DIAGNOSTIC_FILE_UNSAFE
  DIAGNOSTIC_READ_FAILED PUBLIC_CONTROL_UNTRUSTED`.split(/\s+/));

// JSON.parse alone silently accepts duplicate object fields. A bounded lexical
// pass checks nested field identity before its ordinary parser is used.
function parseResponse(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw fail('OWNED_PROTOCOL_INVALID'); }
  let at = 0, nodes = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(source[at] || '\0')) at++; };
  const invalid = () => { throw fail('OWNED_PROTOCOL_INVALID'); };
  const string = () => {
    const begin = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') {
        try { return JSON.parse(source.slice(begin, at)); } catch { invalid(); }
      }
      if (char === '\\') at++;
    }
    invalid();
  };
  const value = depth => {
    if (depth > 32 || ++nodes > 4096) invalid(); whitespace();
    const char = source[at];
    if (char === '"') { string(); return; }
    if (char === '{') {
      at++; whitespace(); const names = new Set(); if (source[at] === '}') { at++; return; }
      for (;;) {
        whitespace(); if (source[at] !== '"') invalid(); const name = string();
        if (names.has(name)) invalid(); names.add(name); whitespace(); if (source[at++] !== ':') invalid();
        value(depth + 1); whitespace(); const next = source[at++]; if (next === '}') return; if (next !== ',') invalid();
      }
    }
    if (char === '[') {
      at++; whitespace(); if (source[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); whitespace(); const next = source[at++]; if (next === ']') return; if (next !== ',') invalid(); }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!literal) invalid(); at += literal[0].length;
  };
  value(0); whitespace(); if (at !== source.length) invalid();
  try { return JSON.parse(source); } catch { invalid(); }
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(fail('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function validOwner(value, digest) {
  return hash(digest) && keys(value, OWNER_KEYS) && integer(value.pid) && value.pid > 0 && integer(value.uid) && value.uid > 0
    && typeof value.startTicks === 'string' && /^\d{1,20}$/.test(value.startTicks)
    && integer(value.executableDevice) && integer(value.executableInode) && value.executableInode > 0
    && value.executableSha256 === digest && port(value.wsPort) && port(value.zeroConfPort) && value.wsPort !== value.zeroConfPort
    && value.wsSocketPid === value.pid && value.zeroConfSocketPid === value.pid
    && value.wsSocketStartTicks === value.startTicks && value.zeroConfSocketStartTicks === value.startTicks;
}
function validSnapshot(value, digest) {
  const playback = value?.playback, zc = value?.zeroConf;
  return keys(value, 'authState,owner,playback,readiness,receivedAt,zeroConf') && validOwner(value.owner, digest)
    && integer(value.receivedAt) && value.receivedAt > 0
    && keys(value.authState, 'is_active,logged_in') && Object.values(value.authState).every(item => typeof item === 'boolean')
    && value.readiness === (value.authState.logged_in ? 'ready' : 'pairing-required')
    && keys(playback, 'durationMs,positionMs,speed,status,uri')
    && [null, 'playing', 'paused', 'stopped', 'buffering', 'loading'].includes(playback.status)
    && (playback.uri === null || uri(playback.uri))
    && [playback.durationMs, playback.positionMs].every(item => item === null || (integer(item) && item <= 3600000))
    && (playback.speed === null || (typeof playback.speed === 'number' && Number.isFinite(playback.speed) && playback.speed >= 0 && playback.speed <= 4))
    && keys(zc, 'deviceID,spotifyError,status') && typeof zc.deviceID === 'string' && /^[\x20-\x7e]{1,256}$/.test(zc.deviceID)
    && [zc.status, zc.spotifyError].every(item => Number.isSafeInteger(item) && Math.abs(item) <= 1000000);
}
function validSeek(value) {
  return keys(value, 'expectedPositionMs,expectedStatus,expectedUri,owner,positionMs,toleranceMs')
    && ownerTag(value.owner)
    && uri(value.expectedUri) && value.expectedStatus === 'paused'
    && [value.expectedPositionMs, value.positionMs, value.toleranceMs].every(item => integer(item) && item <= 3600000)
    && value.toleranceMs <= 1000;
}
function leaseValue(value, running = false) {
  return record(value) && value.owned === true && integer(value.pid) && value.pid > 0
    && typeof value.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt)
    && Number.isFinite(Date.parse(value.startedAt))
    && absolute(value.baseImage) && absolute(value.overlayImage) && keys(value.ports, 'musicAssistant,pcm,soloist,ssh')
    && Object.values(value.ports).every(port) && new Set(Object.values(value.ports)).size === 4
    && (!running || value.state === 'running');
}
function sameLease(a, b) {
  return ['pid', 'startedAt', 'baseImage', 'overlayImage'].every(key => a[key] === b[key])
    && Object.keys(a.ports).every(key => a.ports[key] === b.ports[key]);
}

// Codec observations stay tied to the actual main-owned VM and SDK lifecycle.
// Their format does not claim original bit depth, lossless quality or frame identity.
const qualities = ['standard', 'high', 'lossless'];
const codecs = ['FLAC_FLAC_24BIT', 'OGG_VORBIS', 'FLAC', 'VORBIS', 'AAC', 'OPUS', 'MP3', 'PCM'];
const numericTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validApplianceTag(value) {
  return keys(value, 'pid,ports,startedAt') && integer(value.pid) && value.pid > 0
    && typeof value.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt)
    && Number.isFinite(Date.parse(value.startedAt)) && keys(value.ports, 'musicAssistant,pcm,soloist,ssh')
    && Object.values(value.ports).every(port) && new Set(Object.values(value.ports)).size === 4;
}
function validCodecMarker(value, digest, main = false) {
  return keys(value, main ? 'appliance,daemon,fileIdentity,monotonic,offset,requestedQuality,unixMs'
    : 'daemon,fileIdentity,monotonic,offset,requestedQuality,unixMs')
    && qualities.includes(value.requestedQuality) && validOwner(value.daemon, digest)
    && (value.fileIdentity === null || keys(value.fileIdentity, 'device,inode')
      && integer(value.fileIdentity.device) && integer(value.fileIdentity.inode) && value.fileIdentity.inode > 0)
    && integer(value.offset) && value.offset <= 8 * 1024 * 1024 && (value.fileIdentity !== null || value.offset === 0)
    && numericTime(value.monotonic) && integer(value.unixMs) && value.unixMs > 0 && (!main || validApplianceTag(value.appliance));
}
function sameApplianceTag(tag, lease) {
  return tag.pid === lease.pid && tag.startedAt === lease.startedAt && Object.keys(lease.ports).every(key => tag.ports[key] === lease.ports[key]);
}
function validCodecResult(value, request, digest) {
  const window = value?.window;
  if (!keys(value, 'association,events,incompleteFinalLine,observedDaemon,observedUri,requestedQuality,sourceBitDepth,sourceEncodingVerified,sourceQuality,truncated,window')
    || value.requestedQuality !== request.marker.requestedQuality || value.observedUri !== request.expectedUri
    || !validOwner(value.observedDaemon, digest) || Object.keys(value.observedDaemon).some(key => value.observedDaemon[key] !== request.marker.daemon[key])
    || !keys(window, 'collectedUnixMs,markUnixMs,sinceMonotonic,untilMonotonic') || window.sinceMonotonic !== request.marker.monotonic
    || !numericTime(window.untilMonotonic) || window.untilMonotonic < window.sinceMonotonic || window.untilMonotonic - window.sinceMonotonic > 300
    || window.markUnixMs !== request.marker.unixMs || !integer(window.collectedUnixMs) || window.collectedUnixMs <= 0
    || !keys(value.association, 'currentUriVerified,daemonLifecycle,fileStreamerIdentity,perFrame,timeWindow')
    || !['currentUriVerified', 'daemonLifecycle', 'timeWindow'].every(key => value.association[key] === true)
    || value.association.fileStreamerIdentity !== false || value.association.perFrame !== false
    || value.sourceBitDepth !== null || value.sourceQuality !== null || value.sourceEncodingVerified !== false
    || typeof value.truncated !== 'boolean' || typeof value.incompleteFinalLine !== 'boolean'
    || !Array.isArray(value.events) || value.events.length > 128) return false;
  return value.events.every(event => record(event) && Object.keys(event).length >= 3
    && Object.keys(event).every(key => ['monotonic', 'kind', 'codec', 'sampleRate', 'averageBitrateDiagnostic'].includes(key))
    && numericTime(event.monotonic) && event.monotonic >= window.sinceMonotonic && event.monotonic <= window.untilMonotonic
    && ['renderer', 'file_streamer', 'audio_other'].includes(event.kind)
    && (!Object.hasOwn(event, 'codec') || codecs.includes(event.codec))
    && (!Object.hasOwn(event, 'sampleRate') || integer(event.sampleRate) && event.sampleRate >= 8000 && event.sampleRate <= 768000)
    && (!Object.hasOwn(event, 'averageBitrateDiagnostic') || typeof event.averageBitrateDiagnostic === 'number'
      && Number.isFinite(event.averageBitrateDiagnostic) && event.averageBitrateDiagnostic > 0 && event.averageBitrateDiagnostic <= 100000000));
}
function createOwnedSoloistAppliance({ owner, keyPath, knownHostsPath, sshExecutablePath, sshExecutableSha256,
  assets, resolveAssetContract, spawnProcess = spawn, readPublicFile = fs.readFileSync, timeoutMs = 20000, now = Date.now } = {}) {
  if (process.type === 'renderer' || !owner || typeof owner.start !== 'function' || typeof owner.status !== 'function'
    || ![keyPath, knownHostsPath, sshExecutablePath].every(absolute) || !hash(sshExecutableSha256)
    || (resolveAssetContract !== undefined && typeof resolveAssetContract !== 'function')
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw fail('INVALID_REQUEST');
  const contract = record(assets) ? Object.freeze({ ...assets }) : null;
  let queue = Promise.resolve(), authObserver;
  async function channel(signal) {
    if (signal?.aborted) throw fail('CANCELLED');
    let value;
    try { value = await abortable(Promise.resolve().then(() => owner.start()), signal); }
    catch (error) { throw fail(error?.code === 'CANCELLED' ? 'CANCELLED' : 'APPLIANCE_UNAVAILABLE'); }
    if (signal?.aborted) throw fail('CANCELLED');
    if (!leaseValue(value)) throw fail('APPLIANCE_UNAVAILABLE');
    value = Object.freeze({ ...value, ports: Object.freeze({ ...value.ports }) });
    let current;
    try { current = await abortable(Promise.resolve().then(() => owner.status()), signal); }
    catch (error) { throw fail(error?.code === 'CANCELLED' ? 'CANCELLED' : 'APPLIANCE_CHANGED'); }
    if (signal?.aborted) throw fail('CANCELLED');
    if (!leaseValue(current, true) || !sameLease(value, current)) throw fail('APPLIANCE_CHANGED');
    let actual;
    try { actual = createHash('sha256').update(readPublicFile(sshExecutablePath)).digest('hex'); }
    catch { throw fail('APPLIANCE_CHANNEL_UNAVAILABLE'); }
    if (actual !== sshExecutableSha256) throw fail('APPLIANCE_CHANNEL_UNAVAILABLE');
    if (signal?.aborted) throw fail('CANCELLED');
    return value;
  }
  async function run(operation, request, { signal } = {}) {
    if (signal?.aborted) throw fail('CANCELLED');
    const lease = await channel(signal);
    let asset;
    try { asset = resolveAssetContract ? await abortable(Promise.resolve().then(() => resolveAssetContract({ lease, signal })), signal) : contract; }
    catch (error) { throw fail(error?.code === 'CANCELLED' ? 'CANCELLED' : 'SOLOIST_ASSET_UNVERIFIED'); }
    if (signal?.aborted) throw fail('CANCELLED');
    // A caller-controlled catalog/official install contract must attest this
    // hash. Reporting the guest's own digest does not establish provenance.
    if (!asset || !hash(asset.soloistSha256)) throw fail('SOLOIST_ASSET_UNVERIFIED');
    const expectedDigest = asset.soloistSha256;
    const diagnostic = ['markCodecDiagnostics', 'readCodecDiagnosticsSince'].includes(operation);
    let guestRequest = request;
    if (operation === 'readCodecDiagnosticsSince') {
      if (request.marker.daemon.executableSha256 !== expectedDigest) throw fail('SOLOIST_ASSET_MISMATCH');
      if (!sameApplianceTag(request.marker.appliance, lease)) throw fail('DIAGNOSTIC_APPLIANCE_CHANGED');
      const { appliance: unused, ...marker } = request.marker; guestRequest = { marker, expectedUri: request.expectedUri };
    }
    const body = { operation: operation === 'markCodecDiagnostics' ? 'mark' : operation === 'readCodecDiagnosticsSince' ? 'readSince' : operation,
      soloistSha256: expectedDigest, ...(guestRequest ? { request: guestRequest } : {}) };
    const output = await new Promise((resolve, reject) => {
      let child, timer, settled = false, length = 0; const chunks = [];
      const finish = (error, bytes) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { try { child?.kill(); } catch { /* A reaped child needs no second termination. */ } }
        for (const chunk of chunks) chunk.fill(0);
        if (error) reject(error); else resolve(bytes);
      };
      const abort = () => finish(fail('CANCELLED'));
      const args = ['-i', keyPath, '-p', String(lease.ports.ssh), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${knownHostsPath.replace(/\\/g, '/')}"`, 'folia@127.0.0.1',
        diagnostic ? '/opt/folia/venv/bin/python -I /opt/folia/owned-appliance-codec-diagnostics.py'
          : '/opt/folia/venv/bin/python -I /opt/folia/owned-appliance-control.py'];
      try { child = spawnProcess(sshExecutablePath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')); return; }
      child.on('error', () => finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')));
      child.stdin.on('error', () => finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')));
      child.stdout.on('error', () => finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')));
      child.stdout.on('data', bytes => {
        if (settled) return; length += bytes.length;
        if (length > 65536) finish(fail('OWNED_PROTOCOL_INVALID')); else chunks.push(Buffer.from(bytes));
      });
      child.on('close', code => {
        if (settled) return;
        const bytes = Buffer.concat(chunks, length);
        if (code === 0) { finish(null, bytes); return; }
        let publicCode, authDiagnostic;
        try {
          const value = parseResponse(bytes);
          if (keys(value, 'code,ok') && value.ok === false && PUBLIC_CODES.has(value.code)) publicCode = value.code;
          else if (keys(value, 'code,diagnostic,ok') && value.ok === false && value.code === 'AUTH_SCHEMA_INVALID') {
            authDiagnostic = projectSoloistAuthDiagnostic(value.diagnostic);
            if (authDiagnostic) publicCode = value.code;
          }
        } catch { /* Never expose raw SSH stdout/stderr or authentication state. */ } finally { bytes.fill(0); }
        const failure = fail(publicCode || 'APPLIANCE_CHANNEL_UNAVAILABLE');
        if (authDiagnostic) Object.defineProperty(failure, 'diagnostic', { value: authDiagnostic });
        finish(failure);
      });
      timer = setTimeout(() => finish(fail('OWNED_CONTROL_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { child.stdin.end(JSON.stringify(body)); } catch { finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')); }
    });
    try {
      if (signal?.aborted) throw fail('CANCELLED');
      let current;
      try { current = await abortable(Promise.resolve().then(() => owner.status()), signal); }
      catch (error) { throw fail(error?.code === 'CANCELLED' ? 'CANCELLED' : 'APPLIANCE_CHANGED'); }
      if (signal?.aborted) throw fail('CANCELLED');
      if (!leaseValue(current, true) || !sameLease(current, lease)) throw fail('APPLIANCE_CHANGED');
      const value = parseResponse(output);
      if (!keys(value, 'ok,result') || value.ok !== true) throw fail('OWNED_PROTOCOL_INVALID');
      if (operation === 'markCodecDiagnostics') {
        if (!validCodecMarker(value.result, expectedDigest) || value.result.requestedQuality !== request.requestedQuality) throw fail('OWNED_PROTOCOL_INVALID');
        return Object.freeze({ ...value.result, daemon: Object.freeze({ ...value.result.daemon }),
          fileIdentity: value.result.fileIdentity === null ? null : Object.freeze({ ...value.result.fileIdentity }),
          appliance: Object.freeze({ pid: lease.pid, startedAt: lease.startedAt, ports: Object.freeze({ ...lease.ports }) }) });
      }
      if (operation === 'readCodecDiagnosticsSince') {
        if (!validCodecResult(value.result, request, expectedDigest)) throw fail('OWNED_PROTOCOL_INVALID');
        return value.result;
      }
      if (operation === 'readFresh') {
        if (!validSnapshot(value.result, expectedDigest)) throw fail('OWNED_PROTOCOL_INVALID');
        // Use main receipt time, so a guest RTC offset cannot fake freshness.
        return { ...value.result, receivedAt: now() };
      }
      if (!keys(value.result, 'acknowledged,wsPositionObserved') || value.result.acknowledged !== true
        || value.result.wsPositionObserved !== true) throw fail('OWNED_PROTOCOL_INVALID');
      return { ...value.result };
    } finally { output.fill(0); }
  }
  function serialized(operation, request, options) {
    const task = queue.then(() => run(operation, request, options)); queue = task.catch(() => {}); return task;
  }
  return Object.freeze({
    readFresh(options = {}) {
      const pending = serialized('readFresh', null, options);
      if (!isPreviewDiagnosticsEnabled()) return pending;
      authObserver ||= createSoloistAuthReadObserver({ continuous: true,
        onObservation: event => publishPreviewDiagnostic('spotify.auth-read', event) });
      return authObserver.observe(pending);
    },
    seekOwnedPaused(request, options = {}) {
      if (!validSeek(request)) return Promise.reject(fail('INVALID_REQUEST'));
      return serialized('seekOwnedPaused', { ...request }, options);
    },
    markCodecDiagnostics(request, options = {}) {
      if (!keys(request, 'requestedQuality') || !qualities.includes(request.requestedQuality)) return Promise.reject(fail('INVALID_REQUEST'));
      return serialized('markCodecDiagnostics', { ...request }, options);
    },
    readCodecDiagnosticsSince(request, options = {}) {
      if (!keys(request, 'expectedUri,marker') || !uri(request.expectedUri)
        || !validCodecMarker(request.marker, request.marker?.daemon?.executableSha256, true)) return Promise.reject(fail('INVALID_REQUEST'));
      return serialized('readCodecDiagnosticsSince', JSON.parse(JSON.stringify(request)), options);
    },
    async getChannel({ signal } = {}) {
      const lease = await channel(signal);
      return Object.freeze({ keyPath, knownHostsPath, sshExecutablePath, sshPort: lease.ports.ssh, user: 'folia', pcmPort: lease.ports.pcm,
        musicAssistantPort: lease.ports.musicAssistant, soloistPort: lease.ports.soloist,
        appliancePid: lease.pid, applianceStartedAt: lease.startedAt });
    },
  });
}
module.exports = { createOwnedSoloistAppliance, parseBoundedResponse: parseResponse, publicControlCodes: Object.freeze([...PUBLIC_CODES]) };
