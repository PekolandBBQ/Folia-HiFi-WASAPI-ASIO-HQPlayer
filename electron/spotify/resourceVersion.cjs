'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
// Compare client builds, not Store package numbers or Folia component versions.
function build(value) { return String(value || '').match(/^\s*(\d+\.\d+\.\d+\.\d+)/)?.[1]; }
async function resourceVersion(apps, target) {
 const previous = await require('./upgradeAssets.cjs').findReceipt(apps);
 let saved = previous?.receipt.spotifyVersion;
 if (!saved && previous) {
  try {
   const ini = await fs.readFile(path.join(previous.directory,'roaming/spicetify/config-xpui.ini'),'utf8');
   const backup = ini.match(/^\[Backup\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
   saved = backup?.match(/^version\s*=\s*(.+)$/m)?.[1]?.trim();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 const clientVersion = target?.binaryVersion || (target?.layout !== 'store' ? target?.version : undefined);
 const resourceBuild = build(saved), clientBuild = build(clientVersion);
 return { clientVersion, resourceVersion:saved, state:resourceBuild && clientBuild ? (resourceBuild===clientBuild?'current':'mismatch'):'unknown' };
}
module.exports = { resourceVersion, build };
