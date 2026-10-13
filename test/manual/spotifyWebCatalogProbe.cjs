const { app, safeStorage, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { NCSPOT_CLIENT_ID } = require('../../electron/spotify/catalogLogin.cjs');

// Uses the newly consented catalog identity, with the same persistent cooldown as the application.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const clientId = process.env.FOLIA_SPOTIFY_CLIENT_ID || NCSPOT_CLIENT_ID;
if (!/^[a-f0-9]{32}$/.test(clientId)) throw new Error('Invalid public Client ID');
app.setPath('userData', path.join(directory, 'electron-profile'));
const report = { startedAt: new Date().toISOString(), events: [] };
app.whenReady().then(async () => {
  const catalogDirectory = path.join(directory, 'spotify', 'web-api', clientId);
  const fetcher = (url, options) => net.fetch(url, options);
  report.networkRoute = (await session.defaultSession.resolveProxy('https://api.spotify.com/v1/me')).split(' ')[0];
  const vault = createSessionVault({ directory: catalogDirectory, safeStorage, fetcher });
  const api = createSpotifyCatalog({ vault, directory: catalogDirectory, fetcher, diagnostic: event => report.events.push(event) });
  if (!process.argv.includes('--search-only')) {
    report.stage = 'profile'; const profile = await api.request('status');
    report.profileAvailable = Boolean(profile?.id); report.premium = profile?.product === 'premium';
  }
  report.stage = 'search'; const result = await api.request('search', { query: 'Mr. Brightside', limit: 10 });
  report.searchCount = result.items?.length; report.success = true;
}).catch(error => { report.success = false; report.error = /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'catalog-probe-failed'; })
  .finally(async () => { report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, `web-catalog-${Date.now()}.json`), JSON.stringify(report, null, 2)); app.quit(); });
