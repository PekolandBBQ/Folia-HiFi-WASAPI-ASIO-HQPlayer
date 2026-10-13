'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const LEVELS = Object.freeze({ standard: ['high', 3], high: ['very_high', 4], lossless: ['lossless', 5] });
const fail = code => Object.assign(new Error(`Spotify Soloist: ${code}`), { code });
const REMOTE = '/opt/folia/venv/bin/python -I /opt/folia/apply-quality.py';
function guestFailure(value) {
  return value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'code,ok'
    && value.ok === false && typeof value.code === 'string' && /^[A-Z_]{1,80}$/.test(value.code)
    ? value.code : null;
}

// Trusted-main only. Caller supplies its already owned appliance plan, never
// renderer paths or credentials. Same-level no-op is decided from fresh MA
// readback in the guest, not a host-side cache.
function createSoloistQualityApplier({ plan, spawnProcess = spawn, readPublicFile = fs.readFileSync,
  timeoutMs = 90000 } = {}) {
  if (process.type === 'renderer' || !plan || typeof plan.assertApplianceLease !== 'function'
    || !plan.expectedLease || !['sshExecutablePath', 'keyPath', 'knownHostsPath'].every(key => typeof plan[key] === 'string'
      && path.win32.isAbsolute(plan[key]) && !/[\r\n\0]/.test(plan[key]))
    || !/^[a-f0-9]{64}$/.test(plan.guestPlanSha256 || '') || !/^[a-f0-9]{64}$/.test(plan.sshExecutableSha256 || '')
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw fail('INVALID_REQUEST');
  const approved = Object.freeze({ ...plan, expectedLease: Object.freeze({ ...plan.expectedLease }) });
  async function lease() {
    let current;
    try { current = await approved.assertApplianceLease(); }
    catch { throw fail('APPLIANCE_UNAVAILABLE'); }
    if (!current || Object.keys(approved.expectedLease).some(key => current[key] !== approved.expectedLease[key])) throw fail('APPLIANCE_UNAVAILABLE');
    if (createHash('sha256').update(readPublicFile(approved.sshExecutablePath)).digest('hex') !== approved.sshExecutableSha256)
      throw fail('APPLIANCE_UNAVAILABLE');
  }
  let queue = Promise.resolve();
  async function run(requestedQuality, { signal } = {}) {
    if (!Object.hasOwn(LEVELS, requestedQuality)) throw fail('INVALID_REQUEST');
    if (signal?.aborted) throw fail('CANCELLED');
    await lease();
    if (signal?.aborted) throw fail('CANCELLED');
    const args = ['-i', approved.keyPath, '-p', '22821', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${approved.knownHostsPath}`,
      'root@127.0.0.1', `${REMOTE} --approved-plan-sha256=${approved.guestPlanSha256}`];
    const output = await new Promise((resolve, reject) => {
      let child, settled = false, timer, length = 0;
      const blocks = [];
      const finish = (error, bytes) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) child?.kill();
        for (const block of blocks) block.fill(0);
        if (error) reject(error); else resolve(bytes);
      };
      // After dispatch this transaction must finish its normal guest recovery.
      // Cancellation suppresses its result; it must not leave a provider down.
      // The caller's next request remains serialized until SSH has closed.
      const abort = () => {};
      try { child = spawnProcess(approved.sshExecutablePath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { finish(fail('APPLIANCE_UNAVAILABLE')); return; }
      child.on('error', () => finish(fail('APPLIANCE_UNAVAILABLE')));
      child.stdin.on('error', () => finish(fail('APPLIANCE_UNAVAILABLE')));
      child.stdout.on('data', bytes => {
        if (settled) return;
        length += bytes.length;
        if (length > 8192) finish(fail('QUALITY_PROTOCOL_INVALID')); else blocks.push(Buffer.from(bytes));
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) {
          const bytes = Buffer.concat(blocks, length);
          let publicCode;
          try { publicCode = guestFailure(JSON.parse(bytes.toString('utf8'))); }
          catch { /* Never return raw stderr, stdout or unrecognised text. */ }
          finally { bytes.fill(0); }
          finish(fail(publicCode || 'QUALITY_CONFIGURATION_FAILED')); return;
        }
        finish(null, Buffer.concat(blocks, length));
      });
      timer = setTimeout(() => finish(fail('CONTROL_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish(fail('CANCELLED')); return; }
      child.stdin.end(JSON.stringify({ requestedQuality }));
    });
    try {
      if (signal?.aborted) throw fail('CANCELLED');
      await lease();
      if (signal?.aborted) throw fail('CANCELLED');
      let value;
      try { value = JSON.parse(output.toString('utf8')); }
      catch { throw fail('QUALITY_PROTOCOL_INVALID'); }
      const publicCode = guestFailure(value);
      if (publicCode) throw fail(publicCode);
      if (!value || value.ok !== true) throw fail('QUALITY_PROTOCOL_INVALID');
      const result = value.result;
      const [providerLevel, engineTier] = LEVELS[requestedQuality];
      if (!result || Object.keys(result).sort().join(',') !== 'configurationApplied,engineTier,providerLevel,reloaded,requestedQuality,sourceQuality'
        || result.requestedQuality !== requestedQuality || result.providerLevel !== providerLevel || result.engineTier !== engineTier
        || result.configurationApplied !== true || typeof result.reloaded !== 'boolean' || result.sourceQuality !== null) throw fail('QUALITY_PROTOCOL_INVALID');
      return Object.freeze({ ...result });
    } finally { output.fill(0); }
  }
  return function applyQuality(requestedQuality, options = {}) {
    const task = queue.then(() => run(requestedQuality, options));
    queue = task.catch(() => {}); return task;
  };
}
module.exports = { createSoloistQualityApplier };
