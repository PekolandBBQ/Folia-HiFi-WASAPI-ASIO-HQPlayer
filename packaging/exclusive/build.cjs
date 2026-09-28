const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const release = require('./release.json');

// packaging/exclusive/build.cjs — assemble this fork without changing upstream's release channel.
async function main() {
    const codeRoot = path.resolve(__dirname, '../..');
    const root = path.resolve(process.env.FOLIA_BUILD_ROOT || codeRoot);
    const codePackage = JSON.parse(await fs.readFile(path.join(codeRoot, 'package.json'), 'utf8'));
    const localRequire = createRequire(path.join(root, 'package.json'));
    const { build, Platform } = localRequire('electron-builder');
    const html = await fs.readFile(path.join(codeRoot, 'dist/index.html'), 'utf8');
    if (/\b(?:src|href)="\/(?:assets|runtime-config)/.test(html)) throw new Error('Build renderer with ELECTRON=true');
    const staging = path.join(root, 'build/exclusive-native-audio');
    await fs.mkdir(staging, { recursive: true });
    const catalogFile = process.env.FOLIA_COMPONENT_CATALOG || path.resolve(root, '../folia-native-audio-component/artifacts/development-catalog.json');
    const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
    const hash = data => crypto.createHash('sha256').update(data).digest('hex');
    const releases = [];
    for (const digest of release.componentHashes) {
        const component = catalog.releases.find(item => item.sha256 === digest);
        if (!component) throw new Error('Pinned component missing from build catalog');
        const bytes = await fs.readFile(component.localPath);
        if (hash(bytes) !== digest) throw new Error('Component checksum mismatch');
        const archive = `folia-native-audio-${component.version}-win32-x64.zip`;
        await fs.writeFile(path.join(staging, archive), bytes);
        const { localPath, ...metadata } = component;
        releases.push({ ...metadata, archive });
    }
    await fs.writeFile(path.join(staging, 'exclusive-approved.json'), JSON.stringify({ schema: 1, purpose: 'folia-exclusive-offline-release', releases }, null, 2));
    const ffmpegDir = path.resolve(process.env.FOLIA_FFMPEG_DIR || path.join(root, 'build/ffmpeg/win-x64'));
    const ffmpeg = path.join(ffmpegDir, 'ffmpeg.exe');
    if (hash(await fs.readFile(ffmpeg)) !== release.ffmpegSha256) throw new Error('Unreviewed FFmpeg runtime');
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
    if (!/\bpcm_s24le\b/.test(encoders) || !/\bpcm_s32le\b/.test(encoders)) throw new Error('PCM encoders missing');
    const output = path.resolve(process.env.FOLIA_EXCLUSIVE_OUTPUT || path.join(root, `release/folia-exclusive-${release.version}`));
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('dir'), config: {
        appId: 'io.github.pekolandbbq.folia-exclusive', productName: 'Folia Exclusive HiFi',
        directories: { output },
        extraMetadata: { name: 'folia-exclusive', productName: 'Folia Exclusive HiFi', main: 'electron/exclusive-entry.cjs', version: release.version, dependencies: codePackage.dependencies },
        beforePack: async () => {},
        files: ['package.json', 'build/miao.png', 'build/thumbar/*.png',
            ...['dist', 'electron', 'shared'].map(name => ({ from: path.join(codeRoot, name), to: name, filter: ['**/*'] })),
            { from: path.join(root, 'node_modules/@xmldom/xmldom'), to: 'node_modules/@xmldom/xmldom', filter: ['**/*'] },
            { from: __dirname, to: 'electron', filter: ['exclusive-entry.cjs'] },
            { from: staging, to: 'electron', filter: ['exclusive-approved.json'] }],
        extraResources: [
            { from: ffmpegDir, to: 'ffmpeg-audio' }, { from: staging, to: 'exclusive-native-audio' },
            { from: 'build/icon.png', to: 'icon.png' }, { from: 'build/trayTemplate.png', to: 'trayTemplate.png' },
            { from: 'build/trayTemplate@2x.png', to: 'trayTemplate@2x.png' }],
        win: { signExecutable: false }, publish: null,
    }, publish: 'never' });
    console.log(JSON.stringify({ output, version: release.version, componentVersions: releases.map(r => r.version) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

