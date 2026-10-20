const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');
const { prepareProfile } = require('./profile.cjs');

// packaging/exclusive/exclusive-entry.cjs — fork-only distribution with an isolated profile and pinned offline components.
const resources = path.join(process.resourcesPath, 'exclusive-native-audio');
const approved = require('./exclusive-approved.json');
const release = require('./release.json');
global.__foliaForkRelease = release;
// A local validation package can reuse an isolated test profile without touching the stable profile.
if (release.wrapperLocalValidation && process.env.FOLIA_VALIDATION_PROFILE) {
    release.profile = process.env.FOLIA_VALIDATION_PROFILE;
    release.legacyProfile = release.profile + ' Legacy';
}
let profile;
try {
    profile = prepareProfile(app.getPath('appData'), release.profile, release.legacyProfile);
} catch {
    dialog.showErrorBox('Folia HiFi', '无法迁移旧配置。请关闭旧版程序并检查磁盘空间和目录权限后重试。原 FoliaExclusive 目录未修改。\nUnable to migrate the legacy profile. Close the old app and check disk space and permissions. The original profile has been preserved.');
    app.exit(1);
    return;
}
app.setName(release.productName);
app.setPath('userData', profile);
process.env.ELECTRON_DEV = 'false';
process.env.NODE_ENV = 'production';
if (release.spotifyBackend === 'wrapper') process.env.FOLIA_SPOTIFY_PREVIEW = '1';
if (release.wrapperPreview || release.wrapperLocalValidation || process.env.FOLIA_PRIVATE_DIAGNOSTICS === '1') {
    const logFile = path.join(profile, 'wrapper-validation.jsonl');
    global.__foliaTrialLog = (kind, data) => fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), kind, data }) + '\n');
    require('./debug/privatePreviewDiagnosticBus.cjs').installPreviewDiagnosticSink({ enabled: () => true, record: global.__foliaTrialLog });
}

const catalog = { schema: 1, releases: [
    ...approved.releases.map(r => ({ ...r, localPath: path.join(resources, r.archive) })),
    ...(release.compatibleNativeReleases || []).filter(r => !approved.releases.some(item => item.sha256 === r.sha256)),
] };
const catalogPath = path.join(profile, 'exclusive-component-catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify(catalog));
const directory = path.join(profile, 'components', 'native-audio');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

// Stage bundled releases before changing activation; previously installed files remain recoverable.
function stage(release) {
    const bytes = fs.readFileSync(release.localPath);
    if (hash(bytes) !== release.sha256) throw new Error('Exclusive component archive checksum mismatch');
    const files = unzipSync(bytes);
    const info = JSON.parse(Buffer.from(files['component.json'] || []).toString('utf8'));
    if (info.version !== release.version || info.protocolMajor !== 1 || !files['folia-audio.exe'])
        throw new Error('Exclusive component protocol/version mismatch');
    const target = path.join(directory, `${release.version}-${release.sha256.slice(0,12)}`);
    for (const name of Object.keys(files)) {
        if (!/^[a-zA-Z0-9_.-]+\.(exe|txt|json)$/.test(name) || name.includes('..')) throw new Error('Invalid bundled component entry');
    }
    if (release.entrySha256 && hash(files['folia-audio.exe']) !== release.entrySha256) throw new Error('Exclusive component entry integrity failed');
    if (fs.existsSync(target)) {
        if (hash(fs.readFileSync(path.join(target, 'folia-audio.exe'))) !== hash(files['folia-audio.exe']))
            throw new Error('Existing bundled component entry integrity failed');
    } else {
        const staging = fs.mkdtempSync(path.join(directory, '.bundled-'));
        for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(staging, name), data);
        fs.renameSync(staging, target);
    }
    return { archiveSha256: release.sha256, executableSha256: hash(files['folia-audio.exe']) };
}
let nativeActive = null;
try { nativeActive = JSON.parse(fs.readFileSync(path.join(directory, 'active.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const nativeUpgrade = nativeActive && nativeActive.archiveSha256 !== catalog.releases[0].sha256
    && catalog.releases.some(item => item.sha256 === nativeActive.archiveSha256);
if ((!nativeActive || nativeUpgrade) && !fs.existsSync(path.join(directory, 'inactive.json'))) {
    fs.mkdirSync(directory, { recursive: true });
    const current = stage(catalog.releases[0]);
    if (nativeUpgrade) {
        const receipts = path.join(directory, 'upgrade-receipts'); fs.mkdirSync(receipts, { recursive: true });
        const retained = path.join(receipts, `${nativeActive.archiveSha256}.json`);
        if (!fs.existsSync(retained)) fs.writeFileSync(retained, JSON.stringify({ active: nativeActive,
            previous: fs.existsSync(path.join(directory, 'previous.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'previous.json'), 'utf8')) : null }));
        fs.writeFileSync(path.join(directory, 'previous.json'), JSON.stringify(nativeActive));
    } else {
        const previous = approved.releases.at(-1);
        if (previous.sha256 !== current.archiveSha256) fs.writeFileSync(path.join(directory, 'previous.json'), JSON.stringify(stage(catalog.releases.at(approved.releases.length - 1))));
    }
    fs.writeFileSync(path.join(directory, 'active.json.tmp'), JSON.stringify(current));
    fs.renameSync(path.join(directory, 'active.json.tmp'), path.join(directory, 'active.json'));
}
// This fork entry accepts only the bundled catalog with immutable approved hashes.
// It does not enable local archives or custom catalogs in ordinary packaged Folia.
const componentModule = require('./nativeAudio/componentManager.cjs');
const createManager = componentModule.createComponentManager;
componentModule.createComponentManager = options => createManager({ ...options,
    app: { isPackaged: false, getPath: name => app.getPath(name) }, catalogPath });
const Store = require('electron-store').default || require('electron-store');
const store = new Store({ projectName: 'Folia' });
// Previous packages forced checks off every launch. Migrate once, then respect the user's switch.
if (!store.get('FORK_UPDATE_CHECK_INITIALIZED')) { store.set('ENABLE_UPDATE_CHECK', true); store.set('FORK_UPDATE_CHECK_INITIALIZED', true); }
store.set('ENABLE_AUTO_UPDATE', false);
// The fork's offline HQPlayer package has a separate catalog and activation directory.
const hqpApproved = require('./hqplayer-approved.json');
const hqpCatalog = { schema: 1, releases: [
    ...hqpApproved.releases.map(item => ({ ...item, localPath: path.join(resources, item.archive) })),
    ...(release.compatibleHQPlayerReleases || []).filter(item => !hqpApproved.releases.some(r => r.sha256 === item.sha256)),
] };
const hqpCatalogPath = path.join(profile, 'hqplayer-component-catalog.json');
fs.writeFileSync(hqpCatalogPath, JSON.stringify(hqpCatalog));
const hqpDirectory = path.join(profile, 'components', 'hqplayer');
// Known released components upgrade once; explicit user disable and retained old files remain respected.
require('./hqplayer/bundledUpgrade.cjs').installBundledHQPlayer({directory:hqpDirectory,resources,releases:hqpCatalog.releases});
const hqpModule = require('./hqplayer/componentManager.cjs');
const createHqpManager = hqpModule.createHQPlayerComponentManager;
hqpModule.createHQPlayerComponentManager = options => createHqpManager({ ...options,
    app: { isPackaged: false, getPath: name => app.getPath(name) }, catalogPath: hqpCatalogPath });
require('./main.cjs');
