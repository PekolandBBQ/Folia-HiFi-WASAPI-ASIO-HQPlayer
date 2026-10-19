'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const asar = require('@electron/asar');
const { syncDesktopScripts } = require('./syncDesktopScripts.cjs');

// The only supported reused-package entry: refresh physical scripts before creating installer/ZIP.
async function main() {
  if (!process.argv[2]) throw Error('Usage: node packaging/exclusive/repackage.cjs <candidate win-unpacked>');
  const prepackaged = path.resolve(process.argv[2]), resources = path.join(prepackaged, 'resources');
  await fs.access(path.join(resources, 'app.asar'));
  const scripts = await syncDesktopScripts(resources);
  const entries = asar.listPackage(path.join(resources, 'app.asar'));
  const entry = entries.find(value => value.replace(/\\/g, '/').replace(/^\//, '') === 'electron/release.json');
  if (!entry) throw Error('Packaged fork release metadata missing');
  const release = JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), entry.replace(/^[\\/]/, '')).toString());
  const { build } = require('electron-builder');
  await build({ prepackaged, publish: 'never', config: {
    appId: 'io.github.pekolandbbq.folia-exclusive', productName: release.productName,
    directories: { output: path.dirname(prepackaged) }, publish: null,
    extraMetadata: { version: release.version },
    win: { executableName: release.productName, signExecutable: false, target: [{target:'nsis',arch:['x64']},{target:'zip',arch:['x64']}], artifactName: '${productName}-${version}-win-${arch}.${ext}' },
    nsis: { artifactName: '${productName}-${version}-win-${arch}-Setup.${ext}', oneClick: false, perMachine: false,
      allowElevation: false, packElevateHelper: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false, createStartMenuShortcut: true, runAfterFinish: false, deleteAppDataOnUninstall: false,
      include: path.join(__dirname, 'installer.nsh') },
  } });
  await require('./updateManifest.cjs').prepareUpdateArtifacts(path.dirname(prepackaged), release);
  await fs.writeFile(path.join(path.dirname(prepackaged), 'assembly-inputs.json'), JSON.stringify({
    tag: release.forkTag, build: release.build, scripts, source: 'final app.asar', actualPlaybackVerified: false,
  }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
