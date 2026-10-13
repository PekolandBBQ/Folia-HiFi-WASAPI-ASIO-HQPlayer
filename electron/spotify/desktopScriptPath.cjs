'use strict';
const path = require('node:path');
// PowerShell reads physical files, unlike Electron's ASAR-aware filesystem.
function desktopScriptPath(name) {
  return /\.asar[\\/]/.test(__dirname)
    ? path.join(process.resourcesPath, 'spotify-wrapper', 'scripts', name)
    : path.join(__dirname, name);
}
module.exports = { desktopScriptPath };
