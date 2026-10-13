const path = require('node:path');
const { createComponentManager } = require('../components/archiveManager.cjs');
const { verifyExecutable } = require('./componentProtocol.cjs');

// Optional Spotify transport has its own catalog, hashes and activation; no production release is implied.
function createSpotifyComponentManager({ app, catalogPath, fetchImpl, verifyStaged } = {}) {
  return createComponentManager({ app, fetchImpl,
    catalogPath: catalogPath || (!app.isPackaged && process.env.FOLIA_SPOTIFY_COMPONENT_CATALOG)
      || path.join(__dirname, 'component-catalog.json'),
    descriptor: { id: 'spotify', entry: 'folia-spotify-playback.exe',
      allowedFile: /^(?:folia-spotify-playback\.exe|component\.json|LICENSE\.txt|NOTICE\.txt|THIRD-PARTY-LICENSES\.txt)$/,
      validateRelease: release => { if (!/^[a-f0-9]{64}$/.test(release.entrySha256 || '')) throw new Error('Missing Spotify entry digest'); } },
    verifyStaged: verifyStaged || ((entry, release) => verifyExecutable(entry, release.version)) });
}
module.exports = { createSpotifyComponentManager };
