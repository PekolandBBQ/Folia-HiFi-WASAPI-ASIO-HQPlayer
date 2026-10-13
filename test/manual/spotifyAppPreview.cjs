const { app } = require('electron');
const path = require('node:path');

// Isolated full-app preview using only this task's fresh authorization and public client configuration.
app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview', 'electron-profile'));
process.env.FOLIA_SPOTIFY_PREVIEW_DIRECTORY = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview', 'spotify');
process.env.FOLIA_SPOTIFY_PREVIEW = '1';
process.env.ELECTRON_DEV = 'true';
require('../../electron/main.cjs');
