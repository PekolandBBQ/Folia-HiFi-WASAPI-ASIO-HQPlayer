'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const asar = require('@electron/asar');

// Repackaged apps must use external PowerShell inputs from their own ASAR, never the base package.
const scripts = ['desktopDiscovery.ps1', 'launchStore.ps1', 'StoreActivation.cs', 'installCable.ps1'];
async function syncDesktopScripts(resources) {
  const archive = path.join(resources, 'app.asar');
  // Reassembly may have read the old archive at this same path in this process.
  asar.uncache(archive);
  const entries = asar.listPackage(archive);
  const contents = scripts.map(name => {
    const entry = entries.find(value => value.replace(/\\/g, '/').replace(/^\//, '') === 'electron/spotify/' + name);
    if (!entry) throw Error('Missing packaged desktop script: ' + name);
    return { name, bytes: asar.extractFile(archive, entry.replace(/^[\\/]/, '')) };
  });
  const destination = path.join(resources, 'spotify-wrapper', 'scripts');
  await fs.mkdir(destination, { recursive: true });
  for (const { name, bytes } of contents) await fs.writeFile(path.join(destination, name), bytes);
  return scripts;
}
module.exports = { syncDesktopScripts, scripts };
if (require.main === module) {
  if (!process.argv[2]) throw Error('Pass the candidate resources directory');
  syncDesktopScripts(path.resolve(process.argv[2])).then(names => console.log('Updated packaged scripts: ' + names.join(', ')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
