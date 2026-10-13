'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
// Wrapper code ships in the app; native binaries stay outside ASAR as one pair.
function wrapperPaths({ resourcesPath, profile, home = os.homedir(), environment = process.env }) {
  const native = environment.FOLIA_WRAPPER_NATIVE_ROOT || path.join(resourcesPath, 'spotify-wrapper');
  const directory = path.join(profile, 'spotify');
  const pointer = path.join(directory, 'configured-assets.json');
  const assetRoot = path.join(home, 'FoliaSpotifyAssets', createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0, 16));
  function readApps() {
    try {
      const saved = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      return saved.homeRelativeApps ? path.resolve(home, saved.homeRelativeApps)
        : saved.relativeApps ? path.resolve(directory, saved.relativeApps) : saved.apps;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return environment.FOLIA_WRAPPER_EXISTING_APPS || path.join(directory, 'unconfigured-apps');
  }
  function saveApps(apps) {
    fs.mkdirSync(directory, { recursive: true });
    const relative = path.relative(directory, apps);
    const internal = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const homeRelative = path.relative(home, apps);
    const inAssetRoot = apps.startsWith(assetRoot + path.sep);
    fs.writeFileSync(pointer + '.tmp', JSON.stringify(inAssetRoot ? { schema: 1, homeRelativeApps: homeRelative }
      : internal ? { schema: 1, relativeApps: relative } : { schema: 1, apps }));
    fs.renameSync(pointer + '.tmp', pointer);
  }
  return { readApps, saveApps, native, assetRoot,
    capture: path.join(native, 'spotify-cable', 'folia-capture.exe'),
    route: path.join(native, 'spotify-route') };
}
module.exports = { wrapperPaths };
