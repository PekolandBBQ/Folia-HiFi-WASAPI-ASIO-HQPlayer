const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');
const { folderName, readPointer, writePointer, pruneVersions } = require('./componentVersions.cjs');
const { audioError } = require('./errors.cjs');

// electron/nativeAudio/componentManager.cjs — only host-pinned artifacts may become executable.
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE = 160 * 1024 ** 2;
const MAX_EXPANDED = 260 * 1024 ** 2;
function validateRelease(release) {
    if (!release || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version)
        || release.protocolMajor !== 1 || release.platform !== 'win32-x64'
        || !/^[a-f0-9]{64}$/.test(release.sha256 || '')) throw new Error('Invalid component release manifest');
    return release;
}
function createComponentManager({ app, catalogPath, fetchImpl = fetch }) {
    const directory = path.join(app.getPath('userData'), 'components', 'native-audio');
    const manifest = catalogPath || (!app.isPackaged && process.env.FOLIA_NATIVE_COMPONENT_CATALOG)
        || path.join(__dirname, 'component-catalog.json');
    let busy = false;
    async function catalog() {
        const data = JSON.parse(await fs.readFile(manifest, 'utf8'));
        if (data.schema !== 1 || !Array.isArray(data.releases)) throw new Error('Unsupported component catalog');
        return data.releases.map(validateRelease);
    }
    async function status() {
        const releases = await catalog();
        let active;
        try { active = JSON.parse(await fs.readFile(path.join(directory, 'active.json'), 'utf8')); } catch { /* Not installed. */ }
        const release = releases.find(r => r.sha256 === active?.archiveSha256);
        if (!release) return { available: false, installed: Boolean(active), installable: releases.length > 0, busy,
            ...(active ? { errorCode: 'COMPONENT_INCOMPATIBLE' } : {}) };
        const previous = await readPointer(directory, 'previous.json');
        const executable = path.join(directory, `${release.version}-${release.sha256.slice(0, 12)}`, 'folia-audio.exe');
        try {
            if (digest(await fs.readFile(executable)) !== active.executableSha256) throw new Error('Component integrity check failed');
            return { available: true, installed: true, installable: true, version: release.version,
                updateAvailable: releases[0].sha256 !== release.sha256, rollbackAvailable: Boolean(releases.some(r => r.sha256 === previous?.archiveSha256)), executable, busy };
        } catch (error) { return { available: false, installed: true, installable: true, errorCode: 'COMPONENT_INTEGRITY', busy }; }
    }
    async function readArchive(release) {
        if (!app.isPackaged && release.localPath) {
            if (!path.isAbsolute(release.localPath) || (await fs.stat(release.localPath)).size > MAX_ARCHIVE)
                throw new Error('Invalid development archive');
            return fs.readFile(release.localPath);
        }
        if (!/^https:\/\/github\.com\/chthollyphile\/folia-major\/releases\/download\//.test(release.url || ''))
            throw audioError('COMPONENT_INCOMPATIBLE', 'Component download must use HTTPS from Folia releases');
        const response = await fetchImpl(release.url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.url.startsWith('https://')) throw new Error('Component download failed');
        const chunks = []; let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > MAX_ARCHIVE) throw new Error('Component download exceeds limit');
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    // Stage and validate everything before atomically switching the active pointer. Old versions remain recoverable.
    async function install() {
        if (busy) throw new Error('Component operation already in progress');
        busy = true; let staging;
        try {
            const release = (await catalog())[0];
            if (!release) throw new Error('No approved component release is available yet');
            const archive = await readArchive(release);
            if (digest(archive) !== release.sha256) throw new Error('Component archive checksum mismatch');
            let expanded = 0;
            const files = unzipSync(archive, { filter: entry => {
                if (!/^[a-zA-Z0-9_.-]+\.(?:exe|txt|json)$/.test(entry.name) || entry.name.includes('..'))
                    throw new Error('Unexpected component archive path');
                expanded += entry.originalSize;
                if (expanded > MAX_EXPANDED) throw new Error('Expanded component exceeds limit');
                return true;
            } });
            if (!files['folia-audio.exe']) throw new Error('Component executable is missing');
            const info = JSON.parse(Buffer.from(files['component.json'] || []).toString('utf8'));
            if (info.protocolMajor !== 1 || info.version !== release.version) throw new Error('Component protocol/version mismatch');
            await fs.mkdir(directory, { recursive: true });
            staging = await fs.mkdtemp(path.join(directory, '.install-'));
            for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(staging, name), bytes);
            const destination = path.join(directory, `${release.version}-${release.sha256.slice(0, 12)}`);
            try {
                // Windows can briefly hold newly extracted executables. Retry only sharing/access
                // failures, with a fixed ceiling; persistent locks still leave activation unchanged.
                for (let attempt = 0; ; attempt++) {
                    try { await fs.rename(staging, destination); break; }
                    catch (error) {
                        if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
                    }
                }
                staging = null;
            }
            catch (error) {
                // Reinstall never replaces an executable that might still be mapped by a process.
                // Preserve the original Windows rename failure if no valid destination exists.
                const existing = await fs.readFile(path.join(destination, 'folia-audio.exe')).catch(() => null);
                if (!existing || digest(existing) !== digest(files['folia-audio.exe'])) throw error;
            }
            const previous = await readPointer(directory) || await readPointer(directory, 'inactive.json');
            if (previous && previous.archiveSha256 !== release.sha256) await writePointer(directory, 'previous.json', previous);
            await writePointer(directory, 'active.json', { archiveSha256: release.sha256, executableSha256: digest(files['folia-audio.exe']) });
            await fs.rm(path.join(directory, 'inactive.json'), { force: true });
            await pruneVersions(directory, await catalog());
        } finally {
            try {
                if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(error => {
                    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                    console.warn('[Native audio] Staging cleanup deferred:', error.code);
                });
            } finally { busy = false; }
        }
        return status();
    }
    async function uninstall() {
        if (busy) throw new Error('Component operation already in progress');
        // Removing activation is reversible; retained version folders support rollback and avoid deleting mapped binaries.
        const current = await readPointer(directory);
        if (current) await writePointer(directory, 'inactive.json', current);
        await fs.rm(path.join(directory, 'active.json'), { force: true });
        await pruneVersions(directory, await catalog());
        return status();
    }
    async function rollback() {
        if (busy) throw audioError('INVALID_REQUEST', 'Component operation already in progress');
        busy = true;
        try {
            const releases = await catalog();
            const previous = await readPointer(directory, 'previous.json');
            const release = releases.find(item => item.sha256 === previous?.archiveSha256);
            if (!release) throw audioError('ROLLBACK_UNAVAILABLE', 'No approved previous version');
            const executable = path.join(directory, folderName(release), 'folia-audio.exe');
            if (digest(await fs.readFile(executable)) !== previous.executableSha256) throw audioError('COMPONENT_INTEGRITY');
            const current = await readPointer(directory) || await readPointer(directory, 'inactive.json');
            await writePointer(directory, 'active.json', previous);
            if (current) await writePointer(directory, 'previous.json', current);
            await fs.rm(path.join(directory, 'inactive.json'), { force: true });
            await pruneVersions(directory, releases);
        } finally { busy = false; }
        return status();
    }
    return { status, install, uninstall, rollback };
}
module.exports = { createComponentManager, validateRelease };
