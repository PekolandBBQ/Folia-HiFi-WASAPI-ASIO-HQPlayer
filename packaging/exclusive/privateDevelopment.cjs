'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// packaging/exclusive/privateDevelopment.cjs — isolated, ordinary Electron development startup.
const PRIVATE_PROFILE = 'Folia HiFi Private Development 20261006';
const PRIVATE_VERSION = '0.7.12-private.r37';
const ELECTRON_VERSION = '43.7.5';
const BUILD_ID = '20261010';
const CLIENT_ID = 'fddda707849c459ab149149bc79a0bd2';
const REDIRECT_URI = 'http://127.0.0.1:43821/callback';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function writeJson(file, value) {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === bytes) return;
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
}

// Catalogs retain the application's regular local-archive installation and activation path.
function localCatalog(releases, resourceDirectory) {
    if (!Array.isArray(releases) || releases.length === 0) throw new Error('Private component catalog is missing');
    return { schema: 1, releases: releases.map(release => {
        if (!release || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version || '')
            || release.protocolMajor !== 1 || release.platform !== 'win32-x64' || !validHash(release.sha256)
            || !/^[a-zA-Z0-9_.-]+\.zip$/.test(release.archive || '') || release.archive.includes('..')
            || (release.entrySha256 !== undefined && !validHash(release.entrySha256)))
            throw new Error('Private component catalog is invalid');
        const localPath = path.join(resourceDirectory, release.archive);
        const stat = fs.lstatSync(localPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 160 * 1024 ** 2
            || sha256(fs.readFileSync(localPath)) !== release.sha256)
            throw new Error('Private component checksum mismatch');
        return { version: release.version, protocolMajor: 1, platform: 'win32-x64', sha256: release.sha256,
            ...(release.entrySha256 ? { entrySha256: release.entrySha256 } : {}), localPath };
    }) };
}

// Every private path is derived here, replacing inherited paths from earlier experiments.
function configurePrivateDevelopment({ app, resourcesPath, approved, buildInfo, environment = process.env }) {
    if (!app || app.isPackaged !== false) throw new Error('Private development requires the official Electron default-app launch');
    if (!path.isAbsolute(resourcesPath || '') || !validHash(buildInfo?.soloistManifestSha256)
        || buildInfo?.appVersion !== PRIVATE_VERSION || buildInfo?.electronVersion !== ELECTRON_VERSION
        || buildInfo?.purpose !== 'private-development-only' || buildInfo?.publicReleaseApproved !== false
        || buildInfo?.windowsExecutionTested !== false)
        throw new Error('Private development build identity is invalid');
    const appData = app.getPath('appData');
    if (!path.isAbsolute(appData || '')) throw new Error('Private development AppData path is invalid');
    const target = path.join(appData, PRIVATE_PROFILE);
    fs.mkdirSync(target, { recursive: true });
    const profile = fs.realpathSync(target);
    app.setName('Folia HiFi Private Development');
    app.setPath('userData', profile);
    const spotifyDirectory = path.join(profile, 'spotify');
    fs.mkdirSync(spotifyDirectory, { recursive: true });
    const componentDirectory = path.join(resourcesPath, 'exclusive-native-audio');
    const nativeCatalogPath = path.join(profile, 'private-native-audio-catalog.json');
    const hqpCatalogPath = path.join(profile, 'private-hqplayer-catalog.json');
    const nativeCatalog = localCatalog(approved?.nativeAudio, componentDirectory);
    const hqpCatalog = localCatalog(approved?.hqplayer, componentDirectory);
    writeJson(nativeCatalogPath, nativeCatalog);
    writeJson(hqpCatalogPath, hqpCatalog);
    Object.assign(environment, {
        ELECTRON_DEV: 'false', NODE_ENV: 'production',
        FOLIA_SPOTIFY_PREVIEW: '1', FOLIA_PRIVATE_DIAGNOSTICS: '1',
        FOLIA_SPOTIFY_PREVIEW_DIRECTORY: spotifyDirectory,
        FOLIA_SPOTIFY_NATIVE_PATH: '',
        FOLIA_SPOTIFY_CLIENT_ID: CLIENT_ID, FOLIA_SPOTIFY_REDIRECT_URI: REDIRECT_URI,
        FOLIA_SOLOIST_COMPONENT_DIRECTORY: path.join(resourcesPath, 'spotify-soloist-appliance'),
        FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256: buildInfo.soloistManifestSha256,
        FOLIA_NATIVE_COMPONENT_CATALOG: nativeCatalogPath,
        FOLIA_HQPLAYER_COMPONENT_CATALOG: hqpCatalogPath,
        FOLIA_SPOTIFY_COMPONENT_CATALOG: '',
        FOLIA_DEV_UPDATE_PREVIEW: 'false',
        FOLIA_NATIVE_FFMPEG_PATH: path.join(resourcesPath, 'ffmpeg-audio', 'ffmpeg.exe'),
        FOLIA_TRANSCODE_FFMPEG_PATH: path.join(resourcesPath, 'ffmpeg-audio', 'ffmpeg.exe'),
    });
    return { profile, spotifyDirectory, nativeCatalogPath, hqpCatalogPath };
}

function disablePrivateUpdates({ app, profile, Store }) {
    if (app.isPackaged !== false || app.getPath('userData') !== profile || path.basename(profile) !== PRIVATE_PROFILE)
        throw new Error('Private updater settings require the isolated profile');
    const store = new Store({ projectName: 'Folia', cwd: profile });
    store.set('ENABLE_UPDATE_CHECK', false);
    store.set('ENABLE_AUTO_UPDATE', false);
}

module.exports = { PRIVATE_PROFILE, PRIVATE_VERSION, ELECTRON_VERSION, BUILD_ID, CLIENT_ID, REDIRECT_URI,
    configurePrivateDevelopment, disablePrivateUpdates, localCatalog, sha256 };
