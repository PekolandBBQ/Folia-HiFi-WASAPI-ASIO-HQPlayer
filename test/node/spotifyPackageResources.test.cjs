'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { prepareSpotifyResources } = require('../../packaging/exclusive/spotifyResources.cjs');
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
async function fixture(t, releaseReady = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-spotify-package-'));
    const componentDirectory = path.join(root, 'public-component'), stagingDirectory = path.join(root, 'staging');
    const approvalPath = path.join(root, 'approval.json'), files = {};
    for (const name of ['qemu/qemu-system-x86_64.exe', 'qemu/qemu-img.exe', 'ssh/ssh.exe']) {
        const bytes = Buffer.from('Synthetic public dependency: ' + name); files[name] = hash(bytes);
        await fs.mkdir(path.dirname(path.join(componentDirectory, name)), { recursive: true });
        await fs.writeFile(path.join(componentDirectory, name), bytes);
    }
    const disk = Buffer.from('Synthetic account-free base disk');
    await fs.writeFile(path.join(componentDirectory, 'folia-soloist-clean-base.qcow2'), disk);
    const manifest = { schema: 1, id: 'folia-spotify-soloist-qemu', version: '0.1.0-preview.2', platform: 'win32', arch: 'x64',
        releaseReady, soloist: { bundled: false, perUserOfficialDownload: true }, capabilities: { codecDiagnostics: true },
        owner: { runtimeDirectory: 'qemu', baseImage: 'folia-soloist-clean-base.qcow2', integrity: {
            baseImageSha512: hash(disk, 'sha512'), qemuSha256: files['qemu/qemu-system-x86_64.exe'], qemuImgSha256: files['qemu/qemu-img.exe'] } },
        runtimeFiles: files };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(path.join(componentDirectory, 'component.manifest.json'), bytes);
    const approval = { schema: 1, version: manifest.version, manifestSha256: hash(bytes) };
    await fs.writeFile(approvalPath, JSON.stringify(approval));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(root).startsWith('folia-spotify-package-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, componentDirectory, stagingDirectory, approvalPath, approval, manifest,
        prepare: () => prepareSpotifyResources({ approvalPath, componentDirectory, stagingDirectory }) };
}
test('missing approval stops packaging without emitting a stale runtime pin', async t => {
    const value = await fixture(t); await fs.unlink(value.approvalPath);
    await assert.rejects(value.prepare(), { code: 'SOLOIST_PACKAGE_APPROVAL_REQUIRED' });
    await assert.rejects(fs.stat(value.stagingDirectory), { code: 'ENOENT' });
});
test('a pinned unfinished component cannot enter a packaged EXE', async t => {
    const value = await fixture(t, false);
    await assert.rejects(value.prepare(), { code: 'APPLIANCE_COMPONENT_INVALID' });
    await assert.rejects(fs.stat(value.stagingDirectory), { code: 'ENOENT' });
});
test('invalid, duplicate or oversized approvals fail before any component activation', async t => {
    const value = await fixture(t);
    for (const bytes of [Buffer.from('{"schema":1,"schema":1}'), Buffer.alloc(4097, 32),
        Buffer.from(JSON.stringify({ ...value.approval, manifestSha256: 'self-approved' })),
        Buffer.from(JSON.stringify({ ...value.approval, componentDirectory: value.componentDirectory }))]) {
        await fs.writeFile(value.approvalPath, bytes);
        await assert.rejects(value.prepare(), { code: 'SOLOIST_PACKAGE_APPROVAL_INVALID' });
    }
});
test('version mismatch or corrupt base cannot emit an executable approval', async t => {
    const value = await fixture(t);
    await fs.writeFile(value.approvalPath, JSON.stringify({ ...value.approval, version: '0.2.0' }));
    await assert.rejects(value.prepare(), { code: 'SOLOIST_PACKAGE_VERSION_MISMATCH' });
    await fs.writeFile(value.approvalPath, JSON.stringify(value.approval));
    await fs.appendFile(path.join(value.componentDirectory, 'folia-soloist-clean-base.qcow2'), 'Corruption');
    await assert.rejects(value.prepare(), { code: 'APPLIANCE_COMPONENT_CHANGED' });
});
test('approved resource and ASAR pin agree, preserving per-user official SDK acquisition', async t => {
    const value = await fixture(t), result = await value.prepare();
    assert.deepEqual(result.resource, { from: value.componentDirectory, to: 'spotify-soloist-appliance', filter: ['**/*'] });
    assert.equal(result.version, value.approval.version); assert.equal(result.manifestSha256, value.approval.manifestSha256);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(value.stagingDirectory, 'soloist-appliance-approved.json'), 'utf8')), value.approval);
    assert.equal(value.manifest.soloist.bundled, false);
    assert.equal(value.manifest.soloist.perUserOfficialDownload, true);
});
