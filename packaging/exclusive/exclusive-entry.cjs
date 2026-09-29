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

const catalog = { schema: 1, releases: approved.releases.map(r => ({ ...r, localPath: path.join(resources, r.archive) })) };
const catalogPath = path.join(profile, 'exclusive-component-catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify(catalog));
const directory = path.join(profile, 'components', 'native-audio');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

// Install the two reviewed offline artifacts on first launch, before Electron's ready event.
function stage(release) {
    const bytes = fs.readFileSync(release.localPath);
    if (hash(bytes) !== release.sha256) throw new Error('Exclusive component archive checksum mismatch');
    const files = unzipSync(bytes);
    const target = path.join(directory, `${release.version}-${release.sha256.slice(0,12)}`);
    fs.mkdirSync(target, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
        if (!/^[a-zA-Z0-9_.-]+\.(exe|txt|json)$/.test(name) || name.includes('..')) throw new Error('Invalid bundled component entry');
        fs.writeFileSync(path.join(target, name), data);
    }
    return { archiveSha256: release.sha256, executableSha256: hash(files['folia-audio.exe']) };
}
if (!fs.existsSync(path.join(directory, 'active.json')) && !fs.existsSync(path.join(directory, 'inactive.json'))) {
    fs.mkdirSync(directory, { recursive: true });
    const previous = stage(catalog.releases.at(-1)), current = stage(catalog.releases[0]);
    fs.writeFileSync(path.join(directory, 'previous.json'), JSON.stringify(previous));
    fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify(current));
}
// This fork entry accepts only the bundled catalog with immutable approved hashes.
// It does not enable local archives or custom catalogs in ordinary packaged Folia.
const componentModule = require('./nativeAudio/componentManager.cjs');
const createManager = componentModule.createComponentManager;
componentModule.createComponentManager = options => createManager({ ...options,
    app: { isPackaged: false, getPath: name => app.getPath(name) }, catalogPath });
const Store = require('electron-store').default || require('electron-store');
const store = new Store({ projectName: 'Folia' });
store.set('ENABLE_UPDATE_CHECK', false); store.set('ENABLE_AUTO_UPDATE', false);
// The fork's offline HQPlayer package has a separate catalog and activation directory.
const hqpApproved = require('./hqplayer-approved.json');
const hqpCatalog = { schema: 1, releases: hqpApproved.releases.map(item => ({ ...item, localPath: path.join(resources, item.archive) })) };
const hqpCatalogPath = path.join(profile, 'hqplayer-component-catalog.json');
fs.writeFileSync(hqpCatalogPath, JSON.stringify(hqpCatalog));
const hqpDirectory = path.join(profile, 'components', 'hqplayer');
let previousHqp = null;
try { previousHqp = JSON.parse(fs.readFileSync(path.join(hqpDirectory, 'active.json'), 'utf8')); } catch {}
const bundledUpgrade = previousHqp && previousHqp.archiveSha256 !== hqpCatalog.releases[0].sha256
    && hqpCatalog.releases.some(item => item.sha256 === previousHqp.archiveSha256);
// This local preview upgrades a known bundled component once; explicit user disable remains respected.
if ((!fs.existsSync(path.join(hqpDirectory, 'active.json')) || bundledUpgrade) && !fs.existsSync(path.join(hqpDirectory, 'inactive.json'))) {
    const approved = hqpCatalog.releases[0], bytes = fs.readFileSync(approved.localPath);
    if (hash(bytes) !== approved.sha256) throw new Error('HQPlayer archive integrity failed');
    const files = unzipSync(bytes);
    const info = JSON.parse(Buffer.from(files['component.json']).toString('utf8'));
    if (info.id !== 'hqplayer' || info.version !== approved.version || info.protocolMajor !== 1
        || hash(files['hqplayer-component.cjs']) !== approved.entrySha256) throw new Error('HQPlayer manifest integrity failed');
    const destination = path.join(hqpDirectory, `${approved.version}-${approved.sha256.slice(0, 12)}`);
    fs.mkdirSync(destination, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
        if (!/^(hqplayer-component\.cjs|component\.json|LICENSE\.txt|NOTICE\.txt)$/.test(name)) throw new Error('Unexpected HQPlayer archive entry');
        fs.writeFileSync(path.join(destination, name), data);
    }
    if (bundledUpgrade) fs.writeFileSync(path.join(hqpDirectory, 'previous.json'), JSON.stringify(previousHqp));
    fs.writeFileSync(path.join(hqpDirectory, 'active.json'), JSON.stringify({ archiveSha256: approved.sha256, executableSha256: approved.entrySha256 }));
}
const hqpModule = require('./hqplayer/componentManager.cjs');
const createHqpManager = hqpModule.createHQPlayerComponentManager;
hqpModule.createHQPlayerComponentManager = options => createHqpManager({ ...options,
    app: { isPackaged: false, getPath: name => app.getPath(name) }, catalogPath: hqpCatalogPath });
require('./main.cjs');
