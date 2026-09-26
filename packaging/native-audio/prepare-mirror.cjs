const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createComponentManager, validateRelease } = require('../../electron/nativeAudio/componentManager.cjs');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');

// packaging/native-audio/prepare-mirror.cjs — verified contributor release becomes a Folia-owned artifact.
async function main() {
    const { release } = JSON.parse(await fs.readFile('packaging/native-audio/component-candidate.json', 'utf8'));
    if (!release) throw new Error('尚无经过审查的候选组件 / No reviewed component candidate');
    validateRelease(release);
    const name = `folia-native-audio-${release.version}-win32-x64.zip`;
    const expected = `https://github.com/PekolandBBQ/folia-native-audio-component/releases/download/v${release.version}/${name}`;
    if (release.url !== expected || release.localPath) throw new Error('Unapproved contributor release URL');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-mirror-'));
    let helper;
    try {
        const response = await fetch(expected, { signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.url.startsWith('https://')) throw new Error('Release download failed');
        let size = 0; const chunks = [];
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 160 * 1024 ** 2) throw new Error('Archive exceeds limit');
            chunks.push(chunk);
        }
        const archive = path.join(directory, name);
        await fs.writeFile(archive, Buffer.concat(chunks));
        const catalogPath = path.join(directory, 'catalog.json');
        await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [{ ...release, localPath: archive }] }));
        const manager = createComponentManager({ app: { isPackaged: false, getPath: () => directory }, catalogPath });
        const installed = await manager.install(); // verifies SHA, archive structure and manifest before execution
        helper = createHelper(installed.executable, () => {});
        const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
        if (hello.protocolMajor !== 1 || hello.componentVersion !== release.version ||
            !['local-pcm', 'replaygain', 'format-telemetry'].every(value => hello.capabilities?.includes(value))) throw new Error('Handshake mismatch');
        await fs.mkdir('artifacts/native-mirror', { recursive: true });
        await fs.copyFile(archive, `artifacts/native-mirror/${name}`);
        await fs.writeFile('artifacts/native-mirror/verified.json', JSON.stringify({ version: release.version, sha256: release.sha256, protocolMajor: 1, result: 'PASS' }, null, 2));
        await fs.appendFile(process.env.GITHUB_OUTPUT, `tag=native-audio-v${release.version}\n`);
        console.log('组件校验和握手通过 / Component integrity and handshake passed');
    } finally {
        helper?.dispose();
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
