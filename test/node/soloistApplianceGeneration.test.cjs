const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { planSoloistApplianceGeneration } = require('../../electron/spotify/soloistApplianceGeneration.cjs');
const { createSoloistApplianceOwner } = require('../../electron/spotify/soloistApplianceOwner.cjs');

// Production Owner metadata is exercised with synthetic files and in-memory
// image-tool/QMP children. No VM, OS process, port, vault or user disk is used.
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const options = { dataRoot: 'C:\\private\\soloist-appliance', canonicalBaseImage: 'C:\\public\\folia-soloist-clean-base.qcow2', baseImageSha512: 'a'.repeat(128), platform: 'win32' };
test('generation plan is immutable, inert and keeps its private disk separate from the main vault', () => {
  const plan = planSoloistApplianceGeneration(options);
  assert.match(plan.id, /^[a-f0-9]{64}$/); assert.equal(path.win32.relative(options.dataRoot, plan.dataDirectory), `generations\\${plan.id}\\appliance-data`);
  assert.equal(plan.identity.baseImage, options.canonicalBaseImage); assert.equal(plan.identity.baseSha512, options.baseImageSha512);
  assert.equal(plan.policy.mainVaultPreserved, true); assert.equal(plan.policy.oldGenerationsPreserved, true);
  assert.equal(plan.policy.pairingPreservedAcrossGenerations, false); assert.equal(plan.policy.freshGenerationRequiresPairing, true);
  assert.equal(plan.policy.rebaseAllowed, false); assert.equal(plan.policy.diskCopyAllowed, false);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.identity), true); assert.equal(Object.isFrozen(plan.policy), true);
});
test('same canonical base and hash reuse a generation; hash upgrade and package relocation each isolate a new disk', () => {
  const original = planSoloistApplianceGeneration(options);
  assert.equal(planSoloistApplianceGeneration({ ...options }).dataDirectory, original.dataDirectory);
  assert.notEqual(planSoloistApplianceGeneration({ ...options, baseImageSha512: 'b'.repeat(128) }).dataDirectory, original.dataDirectory);
  assert.notEqual(planSoloistApplianceGeneration({ ...options, canonicalBaseImage: 'C:\\Program Files\\Folia\\resources\\folia-soloist-clean-base.qcow2' }).dataDirectory, original.dataDirectory);
  // Owner stores an exact backing path, so a case spelling change is kept safe.
  assert.notEqual(planSoloistApplianceGeneration({ ...options, canonicalBaseImage: options.canonicalBaseImage.toLowerCase() }).id, original.id);
  assert.equal(planSoloistApplianceGeneration({ ...options, canonicalBaseImage: options.canonicalBaseImage.replace(/\\/g, '/') }).id, original.id);
});
test('generation rejects untrusted path and hash shapes without ever performing filesystem work', () => {
  for (const changes of [{ dataRoot: 'C:\\' }, { dataRoot: 'relative' }, { dataRoot: '\\\\host\\share' },
    { dataRoot: 'C:\\private\\..\\other' }, { dataRoot: 'C:\\private:stream' }, { dataRoot: 'C:\\private.' },
    { dataRoot: 'C:\\nul\\safe' }, { canonicalBaseImage: 'C:\\public\\base.exe' },
    { canonicalBaseImage: 'C:\\public\\base.qcow2\n' }, { baseImageSha512: 'A'.repeat(128) },
    { baseImageSha512: 'a'.repeat(127) }, { platform: 'unknown' }]) {
    assert.throws(() => planSoloistApplianceGeneration({ ...options, ...changes }), { code: 'APPLIANCE_GENERATION_INVALID' });
  }
  const previous = process.type;
  try { process.type = 'renderer'; assert.throws(() => planSoloistApplianceGeneration(options), { code: 'APPLIANCE_GENERATION_INVALID' }); }
  finally { if (previous === undefined) delete process.type; else process.type = previous; }
});
test('POSIX validation keeps exact case and data-root changes cannot modify base identity', () => {
  const first = planSoloistApplianceGeneration({ dataRoot: '/private/user', canonicalBaseImage: '/public/base.qcow2', baseImageSha512: 'a'.repeat(128), platform: 'linux' });
  const second = planSoloistApplianceGeneration({ dataRoot: '/private/another-user', canonicalBaseImage: '/public/base.qcow2', baseImageSha512: 'a'.repeat(128), platform: 'linux' });
  assert.equal(first.id, second.id); assert.notEqual(first.dataDirectory, second.dataDirectory);
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-generation-test-')), runtime = path.join(root, 'qemu'), dataRoot = path.join(root, 'private');
  await fs.mkdir(runtime); await fs.mkdir(dataRoot); const base = path.join(root, 'clean-base.qcow2');
  const originalBase = Buffer.from('synthetic approved base one'), qemuBytes = Buffer.from('synthetic qemu executable'), imageBytes = Buffer.from('synthetic image executable');
  await fs.writeFile(base, originalBase); await fs.writeFile(path.join(runtime, 'qemu-system-x86_64.exe'), qemuBytes); await fs.writeFile(path.join(runtime, 'qemu-img.exe'), imageBytes);
  const calls = [], owners = []; let nextPid = 900000;
  const spawned = (file, args) => {
    calls.push({ file, args }); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.pid = nextPid++; child.exitCode = null; child.signalCode = null; child.stdin.writable = true; child.stdin.destroyed = false;
    const close = code => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); };
    child.kill = () => close(1);
    child.stdin.write = (bytes, callback) => {
      const request = JSON.parse(bytes); setImmediate(() => {
        if (request.execute === 'qmp_capabilities') child.stdout.emit('data', Buffer.from(JSON.stringify({ return: {}, id: request.id }) + '\n'));
        if (['system_powerdown', 'quit'].includes(request.execute)) close(0); callback?.();
      }); return true;
    };
    setImmediate(async () => {
      try {
        if (file.endsWith('qemu-img.exe')) {
          if (args[0] === 'create') await fs.writeFile(args.at(-2), JSON.stringify({ format: 'qcow2', 'full-backing-filename': args[args.indexOf('-b') + 1], 'virtual-size': 17179869184 }));
          else child.stdout.emit('data', await fs.readFile(args.at(-1)));
          close(0);
        } else { child.emit('spawn'); child.stdout.emit('data', Buffer.from('{"QMP":{"version":{"qemu":{"major":10}}}}\n')); }
      } catch { close(1); }
    }); return child;
  };
  const create = (plan, changes = {}) => {
    const owner = createSoloistApplianceOwner({ runtimeDirectory: runtime, baseImage: plan.identity.baseImage, dataDirectory: plan.dataDirectory,
      integrity: { baseImageSha512: plan.identity.baseSha512, qemuSha256: hash(qemuBytes), qemuImgSha256: hash(imageBytes) },
      platform: 'win32', spawnProcess: spawned, reservePorts: async () => ({ ports: { ssh: 51001, musicAssistant: 51002, pcm: 51003, soloist: 51004 }, release: async () => {} }),
      stopTimeoutMs: 100, ...changes }); owners.push(owner); return owner;
  };
  t.after(async () => { await Promise.allSettled(owners.map(owner => owner.close()));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('folia-generation-test-'));
    await fs.rm(root, { recursive: true, force: true }); });
  return { root, runtime, dataRoot, base, originalBase, calls, create,
    plan: (baseImage = base, bytes = originalBase) => planSoloistApplianceGeneration({ dataRoot, canonicalBaseImage: baseImage, baseImageSha512: hash(bytes, 'sha512') }) };
}
test('Owner still rejects a stale disk, while upgraded generation boots independently and preserves old paired bytes and vault', async t => {
  const value = await fixture(t), original = value.plan(); const vault = path.join(value.dataRoot, 'appliance-secrets.enc');
  const vaultBytes = Buffer.from('synthetic encrypted vault fixture'), legacy = path.join(value.dataRoot, 'appliance-data');
  await fs.writeFile(vault, vaultBytes); await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'appliance.qcow2'), 'untouched legacy disk fixture');
  const first = value.create(original); await first.start(); await first.close();
  const oldDisk = path.join(original.dataDirectory, 'appliance.qcow2'); const paired = Buffer.from('synthetic paired private disk state');
  await fs.writeFile(oldDisk, paired); const oldMetadata = await fs.readFile(path.join(original.dataDirectory, 'appliance.json'));
  const upgradedBytes = Buffer.from('synthetic approved base two'); await fs.writeFile(value.base, upgradedBytes);
  const upgraded = value.plan(value.base, upgradedBytes), stale = value.create(upgraded, { dataDirectory: original.dataDirectory });
  await assert.rejects(stale.start(), /appliance-overlay-base-changed/);
  assert.deepEqual(await fs.readFile(oldDisk), paired); assert.deepEqual(await fs.readFile(path.join(original.dataDirectory, 'appliance.json')), oldMetadata);
  const replacement = value.create(upgraded); const lease = await replacement.start(); await replacement.close();
  assert.equal(lease.overlayImage, path.join(upgraded.dataDirectory, 'appliance.qcow2'));
  assert.deepEqual(await fs.readFile(oldDisk), paired); assert.deepEqual(await fs.readFile(vault), vaultBytes);
  assert.equal(await fs.readFile(path.join(legacy, 'appliance.qcow2'), 'utf8'), 'untouched legacy disk fixture');
  assert.equal(value.calls.filter(call => call.args[0] === 'create').length, 2);
  assert.equal(value.calls.some(call => call.args.includes('rebase') || call.args.includes('convert')), false);
});
test('byte-identical install relocation creates a new backing-path generation and exact generation restart reuses its own disk', async t => {
  const value = await fixture(t), original = value.plan(); const first = value.create(original); await first.start(); await first.close();
  const oldBytes = await fs.readFile(path.join(original.dataDirectory, 'appliance.qcow2'));
  const installed = path.join(value.root, 'installed-base.qcow2'); await fs.writeFile(installed, value.originalBase);
  const relocated = value.plan(installed), moved = value.create(relocated); await moved.start(); await moved.close();
  assert.notEqual(relocated.dataDirectory, original.dataDirectory);
  assert.deepEqual(await fs.readFile(path.join(original.dataDirectory, 'appliance.qcow2')), oldBytes);
  const restarted = value.create(relocated); await restarted.start(); await restarted.close();
  assert.equal(value.calls.filter(call => call.args[0] === 'create').length, 2);
});
