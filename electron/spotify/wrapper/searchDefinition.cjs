'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Read the installed client's query identity; never pin a different Spotify build's search hash.
function readSearchDefinition(apps) {
  const file = path.join(apps, 'xpui', 'xpui-routes-search.js');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const match = source.match(/\["searchTracks"\]\s*=\s*new\s+[\w$.]+\("searchTracks","query","([a-f0-9]{64})",null\)/);
  return match ? { name: 'searchTracks', operation: 'query', sha256Hash: match[1], value: null } : null;
}
module.exports = { readSearchDefinition };
