const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateRelease } = require('../../electron/nativeAudio/componentManager.cjs');
const { createHQPlayerComponentManager } = require('../../electron/hqplayer/componentManager.cjs');
const { verify } = require('./verify-rpc.cjs');

// Only reviewed contributor bytes may be mirrored; clients still download solely from Folia releases.
async function main() {
    const { release } = JSON.parse(await fs.readFile('packaging/hqplayer/component-candidate.json', 'utf8'));
    if (!release) throw new Error('No reviewed HQPlayer component candidate');
    validateRelease(release);
    const name = `folia-hqplayer-${release.version}-win32-x64.zip`;
    const expected = `https://github.com/PekolandBBQ/folia-hqplayer-component/releases/download/v${release.version}/${name}`;
    if (release.url !== expected || release.localPath) throw new Error('Unapproved candidate URL');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-hqp-mirror-'));
    try {
        const response = await fetch(expected, { signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.url.startsWith('https://')) throw new Error('Candidate download failed');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 160 * 1024 ** 2) throw new Error('Candidate too large'); chunks.push(chunk); }
        const localPath = path.join(directory, name); await fs.writeFile(localPath, Buffer.concat(chunks));
        const catalogPath = path.join(directory, 'catalog.json'); await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [{ ...release, localPath }] }));
        const manager = createHQPlayerComponentManager({ app: { isPackaged: false, getPath: () => directory }, catalogPath, verifyStaged: verify });
        await manager.install();
        const output = 'artifacts/hqplayer-mirror'; await fs.mkdir(output, { recursive: true });
        await fs.copyFile(localPath, path.join(output, name));
        await fs.writeFile(path.join(output, 'verified.json'), JSON.stringify({ ...release, result: 'PASS' }, null, 2));
        await fs.appendFile(process.env.GITHUB_OUTPUT, `tag=hqplayer-component-v${release.version}\n`);
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
