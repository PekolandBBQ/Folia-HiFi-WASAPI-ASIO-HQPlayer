const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createSoloistQualityApplier } = require('../../electron/spotify/soloistApplyQuality.cjs');

const image = Buffer.from('public ssh fixture');
const sha = createHash('sha256').update(image).digest('hex');
function fixture({ result, exit = 0, delay = 0, changedLease = false } = {}) {
  let observations = 0; const calls = []; const processes = [];
  const plan = { sshExecutablePath: 'C:\\Windows\\ssh.exe', keyPath: 'C:\\private\\id', knownHostsPath: 'C:\\private\\known',
    sshExecutableSha256: sha, guestPlanSha256: 'a'.repeat(64), expectedLease: { pid: 1, sshPort: 22821 },
    assertApplianceLease: async () => { observations++; return { pid: changedLease && observations === 2 ? 2 : 1, sshPort: 22821 }; } };
  const spawnProcess = (file, args, options) => {
    const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stdin = new EventEmitter();
    process.kill = () => { process.killed = true; };
    process.stdin.end = payload => {
      calls.push({ file, args, options, payload });
      const quality = JSON.parse(payload).requestedQuality;
      const level = { standard: ['high', 3], high: ['very_high', 4], lossless: ['lossless', 5] }[quality];
      const value = result || { ok: true, result: { requestedQuality: quality, providerLevel: level[0], engineTier: level[1],
        configurationApplied: true, reloaded: true, sourceQuality: null } };
      setTimeout(() => { process.stdout.emit('data', Buffer.from(JSON.stringify(value))); process.emit('close', exit); }, delay);
    };
    processes.push(process); return process;
  };
  const apply = createSoloistQualityApplier({ plan, spawnProcess, readPublicFile: () => image, timeoutMs: 1000 });
  return { apply, calls, processes, observations: () => observations };
}

test('construction is zero I/O; apply uses fixed command and JSON stdin', async () => {
  const value = fixture(); assert.equal(value.observations(), 0); assert.equal(value.calls.length, 0);
  const result = await value.apply('standard'); assert.equal(result.providerLevel, 'high');
  assert.equal(value.observations(), 2); assert.equal(value.calls.length, 1);
  assert.match(value.calls[0].args.at(-1), /^\/opt\/folia\/venv\/bin\/python -I \/opt\/folia\/apply-quality.py --approved-plan-sha256=[a-f0-9]{64}$/);
  assert.equal(value.calls[0].payload, '{"requestedQuality":"standard"}');
  assert.equal(value.calls[0].options.windowsHide, true); assert.equal(value.calls[0].options.shell, false);
});
test('all quality mappings retain actual source unknown', async () => {
  for (const [requested, expected] of [['standard', ['high', 3]], ['high', ['very_high', 4]], ['lossless', ['lossless', 5]]]) {
    const result = await fixture().apply(requested);
    assert.equal(result.providerLevel, expected[0]); assert.equal(result.engineTier, expected[1]); assert.equal(result.sourceQuality, null);
  }
});
test('invalid quality has zero observation or subprocess activity', async () => {
  const value = fixture(); await assert.rejects(value.apply('unknown'), { code: 'INVALID_REQUEST' });
  assert.equal(value.observations(), 0); assert.equal(value.calls.length, 0);
});
test('pre-cancelled request never launches', async () => {
  const value = fixture(); await assert.rejects(value.apply('high', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.equal(value.calls.length, 0);
});
test('failed config cannot report a switch', async () => {
  const value = fixture({ exit: 1 }); await assert.rejects(value.apply('high'), { code: 'QUALITY_CONFIGURATION_FAILED' });
});
test('nonzero guest exit retains only its bounded public error enum', async () => {
  const value = fixture({ exit: 1, result: { ok: false, code: 'PROVIDER_UNLOAD_TIMEOUT' } });
  await assert.rejects(value.apply('standard'), { code: 'PROVIDER_UNLOAD_TIMEOUT' });
});
test('freeform guest errors and extra fields never escape as public errors', async () => {
  for (const result of [{ ok: false, code: 'secret-token=opaque' },
    { ok: false, code: 'MA_AUTH_REQUIRED', detail: 'private-value' },
    { ok: false, code: 'A'.repeat(81) }]) {
    await assert.rejects(fixture({ exit: 1, result }).apply('standard'), error =>
      error.code === 'QUALITY_CONFIGURATION_FAILED' && !error.message.includes('private')
      && !error.message.includes('opaque'));
  }
});
test('valid guest failure enum is preserved even with a zero process exit', async () => {
  await assert.rejects(fixture({ result: { ok: false, code: 'PCM_SESSION_BUSY' } }).apply('standard'),
    { code: 'PCM_SESSION_BUSY' });
});
test('appliance replacement after configuration invalidates result', async () => {
  const value = fixture({ changedLease: true }); await assert.rejects(value.apply('high'), { code: 'APPLIANCE_UNAVAILABLE' });
});
test('a source-quality claim is rejected even if requested tier matches', async () => {
  const value = fixture({ result: { ok: true, result: { requestedQuality: 'high', providerLevel: 'very_high', engineTier: 4,
    configurationApplied: true, reloaded: true, sourceQuality: 'lossless' } } });
  await assert.rejects(value.apply('high'), { code: 'QUALITY_PROTOCOL_INVALID' });
});
test('cancellation after dispatch waits for normal guest transaction closure without kill', async () => {
  const value = fixture({ delay: 30 }); const controller = new AbortController();
  const pending = value.apply('high', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(value.processes[0].killed, undefined);
});
test('concurrent next-song quality waits behind dispatched previous configuration', async () => {
  const value = fixture({ delay: 25 }); const first = value.apply('high'); const second = value.apply('lossless');
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(value.calls.length, 1);
  await first; await second; assert.equal(value.calls.length, 2);
});
