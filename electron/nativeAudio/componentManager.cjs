const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');

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
        if (!release) return { available: false, installed: false, installable: releases.length > 0, busy };
        const executable = path.join(directory, `${release.version}-${release.sha256.slice(0, 12)}`, 'folia-audio.exe');
        try {
            if (digest(await fs.readFile(executable)) !== active.executableSha256) throw new Error('Component integrity check failed');
            return { available: true, installed: true, installable: true, version: release.version,
                updateAvailable: releases[0].sha256 !== release.sha256, executable, busy };
        } catch (error) { return { available: false, installed: true, installable: true, error: error.message, busy }; }
    }
    async function readArchive(release) {
        if (!app.isPackaged && release.localPath) {
            if (!path.isAbsolute(release.localPath) || (await fs.stat(release.localPath)).size > MAX_ARCHIVE)
                throw new Error('Invalid development archive');
            return fs.readFile(release.localPath);
        }
        if (!/^https:\/\//.test(release.url || '')) throw new Error('Component download must use HTTPS');
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
            try { await fs.rename(staging, destination); staging = null; }
            catch (error) {
                // Reinstall never replaces an executable that might still be mapped by a process.
                if (digest(await fs.readFile(path.join(destination, 'folia-audio.exe'))) !== digest(files['folia-audio.exe'])) throw error;
            }
            const pointer = path.join(directory, 'active.json.tmp');
            await fs.writeFile(pointer, JSON.stringify({ archiveSha256: release.sha256, executableSha256: digest(files['folia-audio.exe']) }));
            await fs.rename(pointer, path.join(directory, 'active.json'));
        } finally { if (staging) await fs.rm(staging, { recursive: true, force: true }); busy = false; }
        return status();
    }
    async function uninstall() {
        if (busy) throw new Error('Component operation already in progress');
        // Removing activation is reversible; retained version folders support rollback and avoid deleting mapped binaries.
        await fs.rm(path.join(directory, 'active.json'), { force: true });
        return status();
    }
    return { status, install, uninstall };
}
module.exports = { createComponentManager, validateRelease };
