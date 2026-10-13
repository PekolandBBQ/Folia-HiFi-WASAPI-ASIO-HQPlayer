const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createSoloistCodecDiagnostics } = require('../../electron/spotify/soloistCodecDiagnostics.cjs');

// Exercise the fixed SSH protocol and bounded diagnostic-only result contract.
const image = Buffer.from('public ssh fixture');
const URI = 'spotify:track:003vvx7Niy0yvhvHt4a68B';
const marker = () => ({ requestedQuality: 'lossless', daemon: { pid: 8, startTicks: '123', uid: 1000 },
  fileIdentity: { device: 1, inode: 2 }, offset: 100, monotonic: 10, unixMs: 10000 });
const evidence = () => ({ requestedQuality: 'lossless', observedUri: URI, observedDaemon: marker().daemon,
  window: { sinceMonotonic: 10, untilMonotonic: 11, markUnixMs: 10000, collectedUnixMs: 11000 },
  events: [{ monotonic: 10.5, kind: 'renderer', codec: 'FLAC_FLAC_24BIT', sampleRate: 44100 }],
  truncated: false, incompleteFinalLine: false,
  association: { timeWindow: true, daemonLifecycle: true, currentUriVerified: true, fileStreamerIdentity: false, perFrame: false },
  sourceBitDepth: null, sourceQuality: null, sourceEncodingVerified: false });
function fixture({ result, exit = 0, delay = 0, changedLease = false, output } = {}) {
  let observations = 0; const calls = []; const children = [];
  const plan = { sshExecutablePath: 'C:\\Windows\\ssh.exe', keyPath: 'C:\\private\\id', knownHostsPath: 'C:\\private\\known',
    sshExecutableSha256: createHash('sha256').update(image).digest('hex'), guestPlanSha256: 'a'.repeat(64),
    expectedLease: { pid: 1 }, assertApplianceLease: async () => ({ pid: ++observations === 2 && changedLease ? 2 : 1 }) };
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.stdin.end = body => {
      calls.push({ file, args, options, body }); const request = JSON.parse(body);
      setTimeout(() => { child.stdout.emit('data', Buffer.from(output || JSON.stringify(result || {
        ok: true, result: request.operation === 'mark' ? marker() : evidence(),
      }))); child.emit('close', exit); }, delay);
    };
    children.push(child); return child;
  };
  const diagnostics = createSoloistCodecDiagnostics({ plan, spawnProcess, readPublicFile: () => image, timeoutMs: 1000 });
  return { diagnostics, calls, children, observations: () => observations };
}
test('construction is zero I/O; mark invokes only fixed reader and quality JSON', async () => {
  const value = fixture(); assert.equal(value.observations(), 0);
  assert.deepEqual(await value.diagnostics.mark('lossless'), marker());
  const call = value.calls[0]; assert.equal(call.body, '{"operation":"mark","requestedQuality":"lossless"}');
  assert.match(call.args.at(-1), /^\/opt\/folia\/venv\/bin\/python -I \/opt\/folia\/read-codec-diagnostics.py --approved-plan-sha256=[a-f0-9]{64}$/);
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false); assert.equal(value.observations(), 2);
});
test('readSince preserves codec diagnostic and all evidence limitations', async () => {
  const value = fixture(); const result = await value.diagnostics.readSince(marker(), URI);
  assert.equal(result.events[0].codec, 'FLAC_FLAC_24BIT'); assert.equal(result.sourceBitDepth, null);
  assert.equal(result.sourceQuality, null); assert.equal(result.sourceEncodingVerified, false);
  assert.equal(result.association.perFrame, false); assert.equal(result.association.fileStreamerIdentity, false);
});
test('invalid quality, URI or marker launches zero subprocesses', async () => {
  const value = fixture();
  await assert.rejects(value.diagnostics.mark('unknown'), { code: 'INVALID_REQUEST' });
  await assert.rejects(value.diagnostics.readSince(marker(), 'file:///untrusted'), { code: 'INVALID_REQUEST' });
  await assert.rejects(value.diagnostics.readSince({ ...marker(), token: 'private' }, URI), { code: 'INVALID_REQUEST' });
  assert.equal(value.calls.length, 0); assert.equal(value.observations(), 0);
});
test('source depth, quality and strong binding claims are rejected', async () => {
  for (const result of [{ ...evidence(), sourceBitDepth: 24 }, { ...evidence(), sourceQuality: 'lossless' },
    { ...evidence(), sourceEncodingVerified: true }, { ...evidence(), association: { ...evidence().association, perFrame: true } }]) {
    await assert.rejects(fixture({ result: { ok: true, result } }).diagnostics.readSince(marker(), URI), { code: 'DIAGNOSTIC_PROTOCOL_INVALID' });
  }
});
test('unknown sensitive event fields, malformed events and expired windows are rejected', async () => {
  for (const events of [[{ ...evidence().events[0], token: 'private' }], [null], [{ ...evidence().events[0], codec: 'SECRET' }],
    [{ ...evidence().events[0], monotonic: 9 }], Array(257).fill(evidence().events[0])]) {
    await assert.rejects(fixture({ result: { ok: true, result: { ...evidence(), events } } }).diagnostics.readSince(marker(), URI),
      { code: 'DIAGNOSTIC_PROTOCOL_INVALID' });
  }
});
test('replaced appliance cannot report stale diagnostics', async () => {
  await assert.rejects(fixture({ changedLease: true }).diagnostics.mark('lossless'), { code: 'APPLIANCE_UNAVAILABLE' });
});
test('only bounded public failure code escapes guest failure', async () => {
  await assert.rejects(fixture({ result: { ok: false, code: 'DIAGNOSTIC_DAEMON_CHANGED' }, exit: 1 }).diagnostics.mark('lossless'),
    { code: 'DIAGNOSTIC_DAEMON_CHANGED' });
  await assert.rejects(fixture({ result: { ok: false, code: 'token=secret' }, exit: 1 }).diagnostics.mark('lossless'),
    { code: 'DIAGNOSTIC_READ_FAILED' });
});
test('read-only cancellation kills pending read immediately', async () => {
  const value = fixture({ delay: 50 }); const controller = new AbortController();
  const pending = value.diagnostics.mark('lossless', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(value.children[0].killed, true);
});
test('oversized guest output is rejected and stopped', async () => {
  const value = fixture({ output: 'x'.repeat(131073) });
  await assert.rejects(value.diagnostics.mark('lossless'), { code: 'DIAGNOSTIC_PROTOCOL_INVALID' });
  assert.equal(value.children[0].killed, true);
});
