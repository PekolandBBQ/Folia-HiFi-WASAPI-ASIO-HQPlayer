const fs = require('node:fs/promises');
const path = require('node:path');
const { audioError } = require('../nativeAudio/errors.cjs');

// electron/nativeAudio/componentVersions.cjs — bounded retention and reviewed catalog policy.
const folderName = release => `${release.version}-${release.sha256.slice(0, 12)}`;
async function readPointer(directory, name = 'active.json') {
    try { return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writePointer(directory, name, value) {
    const target = path.join(directory, name);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(value));
    await fs.rename(`${target}.tmp`, target);
}
async function pruneVersions(directory, releases) {
    const pointers = await Promise.all(['active.json', 'previous.json', 'inactive.json'].map(name => readPointer(directory, name)));
    const keep = new Set(pointers.filter(Boolean).slice(0, 2).map(pointer =>
        releases.find(release => release.sha256 === pointer.archiveSha256)).filter(Boolean).map(folderName));
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
        if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-[a-f0-9]{12}$/.test(entry.name) || keep.has(entry.name)) continue;
        const target = path.resolve(directory, entry.name);
        if (path.dirname(target) !== path.resolve(directory) || entry.isSymbolicLink()) continue;
        try { await fs.rm(target, { recursive: true, force: true }); }
        catch (error) {
            // Activation has already committed. Windows may retain mapped/locked old files;
            // retry their cleanup on the next operation without reporting the update as failed.
            if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
            console.warn('[NativeAudio] Obsolete component cleanup deferred:', entry.name, error.code);
        }
    }
}
function assertCompatibleCatalog(previous, next) {
    for (const release of previous.releases) {
        if (release.protocolMajor === 1 && !next.releases.some(item => item.sha256 === release.sha256 && item.version === release.version))
            throw audioError('COMPONENT_INCOMPATIBLE', 'Keep compatible releases in the approved catalog');
    }
}
module.exports = { folderName, readPointer, writePointer, pruneVersions, assertCompatibleCatalog };
