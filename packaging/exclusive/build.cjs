const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const release = { ...require('./release.json') };

// Local preview packages use their own identity/profile and never migrate the stable profile.
if (process.env.FOLIA_LOCAL_PREVIEW === 'true') Object.assign(release, {
    version: '0.7.9-preview.20260930.3', productName: 'Folia-HiFi-Preview',
    appId: 'io.github.pekolandbbq.folia-exclusive.preview', profile: 'Folia HiFi Preview', legacyProfile: 'Folia HiFi Preview Legacy',
});

// packaging/exclusive/build.cjs — assemble this fork without changing upstream's release channel.
async function main() {
    const codeRoot = path.resolve(__dirname, '../..');
    // electron-builder must walk the physical dependency tree, including junction-backed checkouts.
    const root = path.resolve(process.env.FOLIA_BUILD_ROOT || path.dirname(await fs.realpath(path.join(codeRoot, 'node_modules'))));
    const codePackage = JSON.parse(await fs.readFile(path.join(codeRoot, 'package.json'), 'utf8'));
    if (release.upstreamVersion !== codePackage.version
        || (process.env.FOLIA_LOCAL_PREVIEW !== 'true' && release.version !== codePackage.version)) {
        throw new Error('The HiFi application version must match its upstream base version');
    }
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
    await fs.writeFile(path.join(staging, 'release.json'), JSON.stringify(release, null, 2));
    const hqpPin = require('./hqplayer-approved.json');
    const hqpCatalog = JSON.parse(await fs.readFile(process.env.FOLIA_HQPLAYER_COMPONENT_CATALOG || path.resolve(codeRoot, '../folia-hqplayer-component/artifacts/development-catalog.json'), 'utf8'));
    const hqpReleases = [];
    for (const pin of [hqpPin, ...(hqpPin.previous ? [hqpPin.previous] : [])]) {
        const item = hqpCatalog.releases.find(r => r.version === pin.version && r.sha256 === pin.sha256 && r.entrySha256 === pin.entrySha256);
        if (!item) throw new Error('Pinned HQPlayer component is missing');
        const bytes = await fs.readFile(item.localPath);
        if (hash(bytes) !== pin.sha256) throw new Error('HQPlayer component checksum mismatch');
        const archive = 'folia-hqplayer-' + pin.version + '-win32-x64.zip';
        await fs.writeFile(path.join(staging, archive), bytes);
        const { localPath, ...metadata } = item;
        hqpReleases.push({ ...metadata, archive });
    }
    await fs.writeFile(path.join(staging, 'hqplayer-approved.json'), JSON.stringify({ schema: 1, releases: hqpReleases }, null, 2));
    const ffmpegDir = path.resolve(process.env.FOLIA_FFMPEG_DIR || path.join(root, 'build/ffmpeg/win-x64'));
    const ffmpeg = path.join(ffmpegDir, 'ffmpeg.exe');
    if (hash(await fs.readFile(ffmpeg)) !== release.ffmpegSha256) throw new Error('Unreviewed FFmpeg runtime');
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
    if (!/\bpcm_s24le\b/.test(encoders) || !/\bpcm_s32le\b/.test(encoders)) throw new Error('PCM encoders missing');
    const output = path.resolve(process.env.FOLIA_EXCLUSIVE_OUTPUT || path.join(root, `release/folia-exclusive-${release.version}`));
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis', 'zip']), config: {
        appId: release.appId || 'io.github.pekolandbbq.folia-exclusive', productName: release.productName,
        directories: { output },
        extraMetadata: { name: 'folia-exclusive', productName: release.productName, main: 'electron/exclusive-entry.cjs', version: release.version, dependencies: codePackage.dependencies },
        beforePack: async () => {},
        files: ['!dist/**/*', '!electron/**/*', '!shared/**/*', '!node_modules/@xmldom/**/*', 'package.json', 'build/miao.png', 'build/thumbar/*.png',
            ...['dist', 'electron', 'shared'].map(name => ({ from: path.join(codeRoot, name), to: name, filter: ['**/*'] })),
            { from: __dirname, to: 'electron', filter: ['exclusive-entry.cjs', 'profile.cjs'] },
            { from: staging, to: 'electron', filter: ['exclusive-approved.json', 'hqplayer-approved.json', 'release.json'] }],
        extraResources: [
            { from: ffmpegDir, to: 'ffmpeg-audio' }, { from: staging, to: 'exclusive-native-audio' },
            { from: 'build/icon.png', to: 'icon.png' }, { from: 'build/trayTemplate.png', to: 'trayTemplate.png' },
            { from: 'build/trayTemplate@2x.png', to: 'trayTemplate@2x.png' }],
        extraFiles: [
            { from: path.join(codeRoot, 'README.md'), to: 'README.md' },
            { from: path.join(codeRoot, 'LICENSE'), to: 'LICENSE' },
            { from: path.join(codeRoot, 'docs/exclusive'), to: 'docs/exclusive' },
            { from: path.join(codeRoot, 'docs/native-audio-final-validation.md'), to: 'docs/native-audio-final-validation.md' },
            { from: path.join(codeRoot, 'docs/hqplayer-component-rfc.md'), to: 'docs/hqplayer-component-rfc.md' },
        ],
        win: { signExecutable: false, executableName: release.productName, artifactName: '${productName}-${version}-win-${arch}.${ext}' },
        nsis: {
            artifactName: '${productName}-${version}-win-${arch}-Setup.${ext}',
            oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false, allowToChangeInstallationDirectory: true,
            createDesktopShortcut: false, createStartMenuShortcut: true, runAfterFinish: false,
            deleteAppDataOnUninstall: false, include: path.join(__dirname, 'installer.nsh'),
        },
        publish: null,
    }, publish: 'never' });
    console.log(JSON.stringify({ output, version: release.version, componentVersions: releases.map(r => r.version) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
