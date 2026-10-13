'use strict';
const path = require('node:path');

// electron/spotify/nativeComponentPath.cjs: executable components live outside an ASAR archive, beside unpacked app sources otherwise.
function nativeComponentPath(name, applicationRoot = path.resolve(__dirname, '../..')) {
  if (!['spotify-cable', 'spotify-route'].includes(name)) throw new Error('Unsupported Spotify component');
  const root = applicationRoot.endsWith('.asar') ? applicationRoot + '.unpacked' : applicationRoot;
  return path.join(root, 'native', name);
}
module.exports = { nativeComponentPath };
