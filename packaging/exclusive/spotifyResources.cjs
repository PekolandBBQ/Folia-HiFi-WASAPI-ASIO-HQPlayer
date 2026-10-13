'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { readComponent } = require('../../electron/spotify/soloistApplication.cjs');
const { parseBoundedResponse } = require('../../electron/spotify/soloistOwnedAppliance.cjs');
const fail = code => Object.assign(new Error(`Spotify package: ${code}`), { code });

// A build may include only an independently reviewed, account-free component.
// Missing approval or an experimental manifest stops packaging before the EXE
// is built; the official SDK remains a separate per-user download at runtime.
async function prepareSpotifyResources({ approvalPath, componentDirectory, stagingDirectory } = {}) {
    if (![approvalPath, componentDirectory, stagingDirectory].every(value => typeof value === 'string' && path.isAbsolute(value)))
        throw fail('SOLOIST_PACKAGE_CONFIGURATION_INVALID');
    let approval;
    try {
        const before = await fs.lstat(approvalPath, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 2n || before.size > 4096n)
            throw fail('SOLOIST_PACKAGE_APPROVAL_INVALID');
        const handle = await fs.open(approvalPath, 'r');
        try {
            const same = value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === value[key]);
            if (!same(await handle.stat({ bigint: true }))) throw fail('SOLOIST_PACKAGE_APPROVAL_CHANGED');
            const bytes = Buffer.alloc(Number(before.size));
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (!bytesRead) throw fail('SOLOIST_PACKAGE_APPROVAL_CHANGED'); offset += bytesRead;
            }
            if (!same(await handle.stat({ bigint: true })) || !same(await fs.lstat(approvalPath, { bigint: true })))
                throw fail('SOLOIST_PACKAGE_APPROVAL_CHANGED');
            approval = parseBoundedResponse(bytes);
        } finally { await handle.close(); }
    } catch (error) {
        if (error.code === 'ENOENT') throw fail('SOLOIST_PACKAGE_APPROVAL_REQUIRED');
        if (error.code?.startsWith('SOLOIST_PACKAGE_')) throw error;
        throw fail('SOLOIST_PACKAGE_APPROVAL_INVALID');
    }
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)
        || Object.keys(approval).sort().join(',') !== 'manifestSha256,schema,version' || approval.schema !== 1
        || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(approval.version || '')
        || !/^[a-f0-9]{64}$/.test(approval.manifestSha256 || '')) throw fail('SOLOIST_PACKAGE_APPROVAL_INVALID');
    readComponent({ directory: componentDirectory, manifestSha256: approval.manifestSha256, packaged: true });
    const manifest = parseBoundedResponse(await fs.readFile(path.join(componentDirectory, 'component.manifest.json')));
    if (manifest.version !== approval.version) throw fail('SOLOIST_PACKAGE_VERSION_MISMATCH');
    await fs.mkdir(stagingDirectory, { recursive: true });
    await fs.writeFile(path.join(stagingDirectory, 'soloist-appliance-approved.json'), JSON.stringify(approval, null, 2) + '\n');
    return { resource: { from: componentDirectory, to: 'spotify-soloist-appliance', filter: ['**/*'] },
        version: approval.version, manifestSha256: approval.manifestSha256 };
}
module.exports = { prepareSpotifyResources };
