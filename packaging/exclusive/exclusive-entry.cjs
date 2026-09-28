const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');

// packaging/exclusive/exclusive-entry.cjs — fork-only distribution with an isolated profile and pinned offline components.
const resources = path.join(process.resourcesPath, 'exclusive-native-audio');
const approved = require('./exclusive-approved.json');
const profile = path.join(app.getPath('appData'), 'FoliaExclusive');
app.setName('Folia Exclusive HiFi');
app.setPath('userData', profile);
fs.mkdirSync(profile, { recursive: true });
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
require('./main.cjs');
