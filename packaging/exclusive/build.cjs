const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const release = { ...require('./release.json') };

// Local preview packages use their own identity/profile and never migrate the stable profile.
if (process.env.FOLIA_LOCAL_PREVIEW === 'true') Object.assign(release, {
    productName: 'Folia-HiFi-Wrapper-Preview',
    appId: 'io.github.pekolandbbq.folia-exclusive.wrapper-preview', profile: 'Folia HiFi Wrapper Assembly 20261012', legacyProfile: 'Folia HiFi Wrapper Assembly Legacy',
});

// packaging/exclusive/build.cjs — assemble this fork without changing upstream's release channel.
async function main() {
    release.build = String(Date.now());
    if (!release.forkTag) throw new Error('Fork release tag is required');
    const codeRoot = path.resolve(__dirname, '../..');
    // These external script inputs cannot be resolved by PowerShell inside ASAR.
    for (const name of ['desktopDiscovery.ps1', 'launchStore.ps1', 'StoreActivation.cs', 'installCable.ps1'])
        await fs.access(path.join(codeRoot, 'electron/spotify', name));
    // electron-builder must walk the physical dependency tree, including junction-backed checkouts.
    const root = path.resolve(process.env.FOLIA_BUILD_ROOT || path.dirname(await fs.realpath(path.join(codeRoot, 'node_modules'))));
    const codePackage = JSON.parse(await fs.readFile(path.join(codeRoot, 'package.json'), 'utf8'));
    const sourceVersion = process.env.FOLIA_LOCAL_PREVIEW === 'true' ? codePackage.version.replace(/-private\.r37$/, '') : codePackage.version;
    if (release.upstreamVersion !== sourceVersion || release.version !== sourceVersion) {
        throw new Error('The HiFi application version must match its upstream base version');
    }
    const localRequire = createRequire(path.join(root, 'package.json'));
    const { build, Platform } = localRequire('electron-builder');
    const html = await fs.readFile(path.join(codeRoot, 'dist/index.html'), 'utf8');
    if (/\b(?:src|href)="\/(?:assets|runtime-config)/.test(html)) throw new Error('Build renderer with ELECTRON=true');
    const staging = await fs.mkdtemp(path.join(codeRoot, 'build/wrapper-assembly-'));
    await fs.mkdir(staging, { recursive: true });
    const wrapperDirectory = path.join(staging, 'spotify-wrapper');
    const wrapper = await require('./wrapperResources.cjs').prepareWrapperResources({
        source: path.resolve(process.env.FOLIA_WRAPPER_NATIVE_ROOT || path.join(codeRoot, 'build/spotify-wrapper')),
        destination: wrapperDirectory,
        preview: process.env.FOLIA_LOCAL_PREVIEW === 'true',
        localValidation: process.env.FOLIA_LOCAL_ACCEPTANCE === 'true',
    });
    release.spotifyBackend = 'wrapper';
    release.wrapperPreview = wrapper.preview;
    release.wrapperLocalValidation = wrapper.localValidation;
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
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(process.env.FOLIA_ASSEMBLY_ONLY === 'true' ? ['dir'] : ['nsis', 'zip']), config: {
        appId: release.appId || 'io.github.pekolandbbq.folia-exclusive', productName: release.productName,
        directories: { output },
        extraMetadata: { name: 'folia-exclusive', productName: release.productName, main: 'electron/exclusive-entry.cjs', version: release.version, dependencies: codePackage.dependencies },
        beforePack: async () => {},
        afterPack: require(path.join(root, 'build/afterPack.cjs')).default,
        asarUnpack: ['electron/spotify/*.ps1', 'electron/analysis/htdemucs_runner.py', 'node_modules/@koromix/koffi-*/**/*.node'],
        files: ['!dist/**/*', '!electron/**/*', '!shared/**/*', '!native/**/*', '!node_modules/@xmldom/**/*', 'package.json', 'build/miao.png', 'build/thumbar/*.png',
            ...['dist', 'electron', 'shared'].map(name => ({ from: path.join(codeRoot, name), to: name, filter: ['**/*'] })),
            { from: __dirname, to: 'electron', filter: ['exclusive-entry.cjs', 'profile.cjs'] },
            { from: staging, to: 'electron', filter: ['exclusive-approved.json', 'hqplayer-approved.json', 'release.json'] }],
        extraResources: [
            { from: ffmpegDir, to: 'ffmpeg-audio' }, { from: staging, to: 'exclusive-native-audio', filter: ['*.zip', '*.json'] },
            { from: wrapperDirectory, to: 'spotify-wrapper' },
            { from: path.join(codeRoot, 'electron/spotify'), to: 'spotify-wrapper/scripts', filter: ['*.ps1', 'StoreActivation.cs'] },
            { from: 'build/icon.png', to: 'icon.png' }, { from: 'build/trayTemplate.png', to: 'trayTemplate.png' },
            { from: 'build/trayTemplate@2x.png', to: 'trayTemplate@2x.png' }],
        extraFiles: [
            { from: path.join(codeRoot, 'README.md'), to: 'README.md' },
            { from: path.join(codeRoot, 'LICENSE'), to: 'LICENSE' },
            { from: path.join(codeRoot, 'docs/exclusive'), to: 'docs/exclusive' },
            { from: path.join(codeRoot, 'docs/native-audio-final-validation.md'), to: 'docs/native-audio-final-validation.md' },
            { from: path.join(codeRoot, 'docs/hqplayer-component-rfc.md'), to: 'docs/hqplayer-component-rfc.md' },
        ],
        win: { icon: path.join(codeRoot, 'build/icon.ico'), signExecutable: false, executableName: release.productName, artifactName: '${productName}-${version}-win-${arch}.${ext}' },
        nsis: {
            artifactName: '${productName}-${version}-win-${arch}-Setup.${ext}',
            oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false, allowToChangeInstallationDirectory: true,
            createDesktopShortcut: false, createStartMenuShortcut: true, runAfterFinish: false,
            deleteAppDataOnUninstall: false, include: path.join(__dirname, 'installer.nsh'),
        },
        publish: null,
    }, publish: 'never' });
    if (process.env.FOLIA_ASSEMBLY_ONLY !== 'true') {
      const names = await fs.readdir(output);
      const manifest = { schema: 1, tag: release.forkTag, build: release.build,
        installer: names.find(n => n === release.productName + '-' + release.version + '-win-x64-Setup.exe'),
        portable: names.find(n => n === release.productName + '-' + release.version + '-win-x64.zip') };
      if (!manifest.installer || !manifest.portable) throw new Error('Missing fork update artifacts');
      await fs.writeFile(path.join(output, 'folia-hifi-update.json'), JSON.stringify(manifest, null, 2));
    }
    console.log(JSON.stringify({ output, version: release.version, componentVersions: releases.map(r => r.version),
        spotifyComponentVersion: wrapper.bundleVersion }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
