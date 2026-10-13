'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createOwnedSoloistAppliance } = require('../../electron/spotify/soloistOwnedAppliance.cjs');

// test/node/soloistOwnedCodecDiagnostics.test.cjs: synthetic main-owned process
// channels only. No SSH, VM, installed application, original log or key is used.
const SHA = 'b'.repeat(64), URI = 'spotify:track:003vvx7Niy0yvhvHt4a68B', SSH = Buffer.from('Synthetic public SSH bytes');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const lease = () => ({ pid: 873, startedAt: '2026-10-03T10:30:01.123Z', owned: true,
  ports: { ssh: 51311, musicAssistant: 51312, pcm: 51313, soloist: 51314 }, baseImage: 'C:\\public\\base.qcow2', overlayImage: 'C:\\fixture\\owned.qcow2' });
const daemon = () => ({ pid: 71, startTicks: '710', uid: 1001, executableDevice: 1, executableInode: 99,
  executableSha256: SHA, wsPort: 37101, zeroConfPort: 44211, wsSocketPid: 71, zeroConfSocketPid: 71,
  wsSocketStartTicks: '710', zeroConfSocketStartTicks: '710' });
const marker = () => ({ requestedQuality: 'lossless', daemon: daemon(), fileIdentity: { device: 1, inode: 2 }, offset: 100, monotonic: 10, unixMs: 10000 });
const taggedMarker = () => { const value = lease(); return { ...marker(), appliance: { pid: value.pid, startedAt: value.startedAt, ports: value.ports } }; };
const request = () => ({ marker: taggedMarker(), expectedUri: URI });
const report = () => ({ requestedQuality: 'lossless', observedUri: URI, observedDaemon: daemon(),
  window: { sinceMonotonic: 10, untilMonotonic: 11, markUnixMs: 10000, collectedUnixMs: 11000 },
  events: [{ monotonic: 10.2, kind: 'renderer', codec: 'FLAC_FLAC_24BIT', sampleRate: 44100, averageBitrateDiagnostic: 500.5 }],
  truncated: false, incompleteFinalLine: false, association: { timeWindow: true, daemonLifecycle: true, currentUriVerified: true,
    fileStreamerIdentity: false, perFrame: false }, sourceBitDepth: null, sourceQuality: null, sourceEncodingVerified: false });

function fixture(options = {}) {
  const owned = lease(), calls = [], children = []; let starts = 0, statuses = 0, reads = 0;
  const owner = { start: () => { starts++; return owned; }, status: () => { statuses++; return { ...owned, state: 'running',
    ...(options.changedLease && statuses >= 2 ? options.changedLease : {}) }; } };
  const adapter = createOwnedSoloistAppliance({ owner, keyPath: 'C:\\fixture\\client-key', knownHostsPath: 'C:\\fixture with spaces\\known-hosts',
    sshExecutablePath: 'C:\\public\\ssh.exe', sshExecutableSha256: createHash('sha256').update(SSH).digest('hex'),
    assets: { soloistSha256: options.assetSha || SHA }, readPublicFile: () => { reads++; return SSH; }, timeoutMs: options.timeoutMs || 1000,
    spawnProcess(file, args, flags) {
      const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kills = 0;
      child.kill = () => { child.kills++; };
      child.respond = (value, code = 0) => { child.stdout.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value)); child.emit('close', code); };
      child.stdin.end = body => { const decoded = JSON.parse(body); calls.push({ file, args, flags, decoded });
        if (options.hold) return;
        setImmediate(() => {
          if (options.stdoutError) { child.stdout.emit('error', Object.assign(Error('private pipe details'), { code: 'EPIPE' })); return; }
          if (options.result) { child.respond(JSON.stringify(options.result(decoded)), options.exit || 0); return; }
          const result = decoded.operation === 'mark' ? { ...marker(), requestedQuality: decoded.request.requestedQuality } : report();
          child.respond(JSON.stringify({ ok: true, result }));
        }); };
      children.push(child); return child;
    } });
  return { adapter, calls, children, owned, counts: () => ({ starts, statuses, reads }) };
}

test('codec methods are inert until explicitly requested and use the trusted dynamic folia channel', async () => {
  const value = fixture(); assert.deepEqual(value.counts(), { starts: 0, statuses: 0, reads: 0 });
  const result = await value.adapter.markCodecDiagnostics({ requestedQuality: 'lossless' });
  assert.deepEqual(result, taggedMarker()); assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.appliance.ports), true); assert.equal(Object.isFrozen(result.daemon), true);
  const call = value.calls[0]; assert.equal(call.args.at(-1), '/opt/folia/venv/bin/python -I /opt/folia/owned-appliance-codec-diagnostics.py');
  assert.ok(call.args.includes('folia@127.0.0.1')); assert.equal(call.args[call.args.indexOf('-p') + 1], '51311');
  assert.ok(call.args.includes('UserKnownHostsFile="C:/fixture with spaces/known-hosts"'));
  assert.deepEqual(call.flags, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.deepEqual(call.decoded, { operation: 'mark', soloistSha256: SHA, request: { requestedQuality: 'lossless' } });
  assert.equal(call.args.some(arg => arg.includes('--approved-plan')), false); assert.equal(call.args.includes('root@127.0.0.1'), false);
});

test('readSince proves the same appliance and strips main lease fields before guest stdin', async () => {
  const value = fixture(), result = await value.adapter.readCodecDiagnosticsSince(request());
  assert.deepEqual(result, report()); assert.deepEqual(value.calls[0].decoded,
    { operation: 'readSince', soloistSha256: SHA, request: { marker: marker(), expectedUri: URI } });
  assert.equal(result.sourceQuality, null); assert.equal(result.sourceBitDepth, null); assert.equal(result.sourceEncodingVerified, false);
  assert.equal(result.association.perFrame, false); assert.equal(result.association.fileStreamerIdentity, false);
});

test('wrong main appliance PID, start time or any dynamic forward cannot launch guest diagnostics', async () => {
  for (const change of [tag => { tag.pid++; }, tag => { tag.startedAt = '2026-10-03T10:30:02.123Z'; },
    ...['ssh', 'musicAssistant', 'pcm', 'soloist'].map(key => tag => { tag.ports[key] += 10; })]) {
    const value = fixture(), input = request(); change(input.marker.appliance);
    await assert.rejects(value.adapter.readCodecDiagnosticsSince(input), { code: 'DIAGNOSTIC_APPLIANCE_CHANGED' }); assert.equal(value.calls.length, 0);
  }
});

test('SDK asset changes reject a previous marker before invoking any guest control', async () => {
  const value = fixture({ assetSha: 'c'.repeat(64) });
  await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), { code: 'SOLOIST_ASSET_MISMATCH' }); assert.equal(value.calls.length, 0);
});

test('malformed markers, untrusted paths, raw fields and pre-cancellation perform zero owner I/O', async () => {
  const value = fixture();
  for (const input of [{ requestedQuality: 'automatic' }, { requestedQuality: 'lossless', path: '/private' }, null])
    await assert.rejects(value.adapter.markCodecDiagnostics(input), { code: 'INVALID_REQUEST' });
  for (const change of [v => { delete v.marker.appliance; }, v => { v.marker.offset = true; }, v => { v.marker.monotonic = Infinity; },
    v => { v.marker.fileIdentity.inode = 0; }, v => { v.marker.daemon.token = 'secret'; }, v => { v.path = '/private'; },
    v => { v.marker.daemon.executableSha256 = 'not-a-digest'; }, v => { v.marker.daemon.executableSha256 = 123; },
    v => { v.expectedUri = 'file:///private'; }, v => { v.marker.appliance.ports.ssh = v.marker.appliance.ports.pcm; }]) {
    const input = request(); change(input); await assert.rejects(value.adapter.readCodecDiagnosticsSince(input), { code: 'INVALID_REQUEST' });
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(value.adapter.markCodecDiagnostics({ requestedQuality: 'lossless' }, { signal: abort.signal }), { code: 'CANCELLED' });
  await assert.rejects(value.adapter.readCodecDiagnosticsSince(request(), { signal: abort.signal }), { code: 'CANCELLED' });
  assert.deepEqual(value.counts(), { starts: 0, statuses: 0, reads: 0 }); assert.equal(value.calls.length, 0);
});

test('SSH configuration paths reject quoted or control-character option injection before owner I/O', () => {
  const configuration = { owner: { start() { throw Error('Unexpected owner start'); }, status() { throw Error('Unexpected owner status'); } },
    keyPath: 'C:\\fixture\\client-key', knownHostsPath: 'C:\\fixture\\known-hosts', sshExecutablePath: 'C:\\public\\ssh.exe',
    sshExecutableSha256: createHash('sha256').update(SSH).digest('hex'), assets: { soloistSha256: SHA } };
  for (const field of ['keyPath', 'knownHostsPath', 'sshExecutablePath']) {
    for (const bad of ['\u0001', '\t', '\r', '\n', '\0', '\u007f', '"']) {
      assert.throws(() => createOwnedSoloistAppliance({ ...configuration, [field]: `C:\\fixture\\bad${bad}path` }), { code: 'INVALID_REQUEST' });
    }
  }
});

test('guest marker exact schema and full daemon proof cannot be weakened or changed to another requested tier', async () => {
  for (const change of [v => { v.requestedQuality = 'high'; }, v => { v.daemon.executableSha256 = 'c'.repeat(64); },
    v => { v.daemon.wsSocketPid = 72; }, v => { v.daemon.zeroConfSocketStartTicks = '711'; }, v => { v.fileIdentity.inode = 0; },
    v => { v.monotonic = -1; }, v => { v.offset = 8 * 1024 * 1024 + 1; }, v => { v.token = 'secret'; },
    v => { v.fileIdentity = null; }]) {
    const value = fixture({ result: () => { const result = marker(); change(result); return { ok: true, result }; } });
    await assert.rejects(value.adapter.markCodecDiagnostics({ requestedQuality: 'lossless' }), { code: 'OWNED_PROTOCOL_INVALID' });
  }
});

test('codec report rejects source-quality claims, raw bits, private fields and dishonest association', async () => {
  for (const change of [v => { v.sourceBitDepth = 24; }, v => { v.sourceQuality = 'lossless'; }, v => { v.sourceEncodingVerified = true; },
    v => { v.association.perFrame = true; }, v => { v.association.fileStreamerIdentity = true; }, v => { v.token = 'secret'; },
    v => { v.events[0].bits = 32; }, v => { v.events[0].originalLine = 'private'; }, v => { v.events[0].codec = 'UNKNOWN'; }]) {
    const value = fixture({ result: () => { const result = report(); change(result); return { ok: true, result }; } });
    await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), { code: 'OWNED_PROTOCOL_INVALID' });
  }
});

test('report owner, current URI, requested tier, time window and bounded event values must match the marker', async () => {
  for (const change of [v => { v.observedDaemon.executableInode++; }, v => { v.observedUri = 'spotify:track:' + 'A'.repeat(22); },
    v => { v.requestedQuality = 'high'; }, v => { v.window.sinceMonotonic = 9; }, v => { v.window.untilMonotonic = 311; },
    v => { v.window.markUnixMs++; }, v => { v.events[0].monotonic = 9; }, v => { v.events[0].sampleRate = true; },
    v => { v.events[0].averageBitrateDiagnostic = Infinity; }, v => { v.events = Array.from({ length: 129 }, () => clone(v.events[0])); }]) {
    const value = fixture({ result: () => { const result = report(); change(result); return { ok: true, result }; } });
    await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), { code: 'OWNED_PROTOCOL_INVALID' });
  }
});

test('empty or truncated codec evidence remains unknown and cannot imply a source-quality pass', async () => {
  const result = report(); result.events = []; result.truncated = true; result.incompleteFinalLine = true;
  const value = fixture({ result: () => ({ ok: true, result }) }), received = await value.adapter.readCodecDiagnosticsSince(request());
  assert.deepEqual(received.events, []); assert.equal(received.sourceQuality, null); assert.equal(received.sourceEncodingVerified, false);
  assert.equal(received.truncated, true); assert.equal(received.incompleteFinalLine, true);
});

test('only known codec failures are projected, without returning raw output or account fields', async () => {
  for (const code of ['DIAGNOSTIC_FILE_CHANGED', 'DIAGNOSTIC_DAEMON_CHANGED', 'DIAGNOSTIC_TRACK_CHANGED', 'DIAGNOSTIC_AUTH_REQUIRED']) {
    const value = fixture({ result: () => ({ ok: false, code }), exit: 1 });
    await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), { code });
  }
  const value = fixture({ result: () => ({ ok: false, code: 'DIAGNOSTIC_TRACK_CHANGED', token: 'private' }), exit: 1 });
  await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), error => error.code === 'APPLIANCE_CHANNEL_UNAVAILABLE' && !error.message.includes('private'));
});

test('an appliance replacement during a read cannot export the earlier codec proof', async () => {
  const value = fixture({ changedLease: { pid: 874 } });
  await assert.rejects(value.adapter.readCodecDiagnosticsSince(request()), { code: 'APPLIANCE_CHANGED' }); assert.equal(value.calls.length, 1);
});

test('timeout, cancellation and stdout EPIPE remain bounded to the pending owned child', async () => {
  const timed = fixture({ hold: true, timeoutMs: 100 });
  await assert.rejects(timed.adapter.readCodecDiagnosticsSince(request()), { code: 'OWNED_CONTROL_TIMEOUT' }); assert.equal(timed.children[0].kills, 1);
  const cancelled = fixture({ hold: true }), controller = new AbortController();
  const pending = cancelled.adapter.markCodecDiagnostics({ requestedQuality: 'lossless' }, { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(cancelled.children[0].kills, 1);
  const broken = fixture({ stdoutError: true });
  await assert.rejects(broken.adapter.readCodecDiagnosticsSince(request()), error => error.code === 'APPLIANCE_CHANNEL_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(broken.children[0].kills, 1);
});

test('a queued diagnostic request owns a clone of its validated marker, preserving same-URI guards', async () => {
  const value = fixture({ hold: true });
  const blocking = value.adapter.markCodecDiagnostics({ requestedQuality: 'lossless' }); await tick();
  const input = request(), pending = value.adapter.readCodecDiagnosticsSince(input); input.expectedUri = 'spotify:track:' + 'A'.repeat(22);
  input.marker.daemon.pid = 999; input.marker.appliance.ports.ssh = 65500;
  value.children[0].respond(JSON.stringify({ ok: true, result: marker() })); await blocking; await tick();
  assert.equal(value.calls[1].decoded.request.expectedUri, URI); assert.equal(value.calls[1].decoded.request.marker.daemon.pid, 71);
  value.children[1].respond(JSON.stringify({ ok: true, result: report() })); await pending;
});
