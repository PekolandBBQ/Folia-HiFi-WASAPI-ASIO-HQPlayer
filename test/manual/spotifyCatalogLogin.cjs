const { app, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const { createCatalogLogin, NCSPOT_CLIENT_ID } = require('../../electron/spotify/catalogLogin.cjs');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');

// Authorized fresh ncspot pairing; reports contain only the consent URL and non-sensitive test counts.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const clientId = process.env.FOLIA_SPOTIFY_CLIENT_ID || NCSPOT_CLIENT_ID;
if (!/^[a-f0-9]{32}$/.test(clientId)) throw new Error('Invalid public Client ID');
app.setPath('userData', path.join(directory, 'electron-profile'));
let login;
const output = path.join(directory, `catalog-pairing-${Date.now()}.json`);
const report = { startedAt: new Date().toISOString(), state: 'starting', events: [] };
const save = () => fs.writeFile(output, JSON.stringify(report, null, 2));
app.whenReady().then(async () => {
  const catalogDirectory = path.join(directory, 'spotify', 'web-api', clientId);
  const vault = createSessionVault({ directory: catalogDirectory, safeStorage, fetcher: (url, options) => net.fetch(url, options) });
  login = createCatalogLogin({ vault, clientId, redirectUri: process.env.FOLIA_SPOTIFY_REDIRECT_URI,
    fetcher: (url, options) => net.fetch(url, options),
    renderQr: url => QRCode.toDataURL(url), openAuthorization: async url => { report.state = 'waiting'; report.authorizationUrl = url; await save(); } });
  const key = await login.begin();
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = login.check(key); if (['waiting', 'scanned'].includes(result.state)) continue;
    report.state = result.state; delete report.authorizationUrl; await save();
    if (result.state !== 'confirmed') return;
    const api = createSpotifyCatalog({ vault, directory: catalogDirectory, fetcher: (url, options) => net.fetch(url, options), diagnostic: event => report.events.push(event) });
    report.stage = 'profile'; const profile = await api.request('status');
    report.profileAvailable = Boolean(profile?.id); report.premium = profile?.product === 'premium';
    report.stage = 'search'; const search = await api.request('search', { query: 'Mr. Brightside', limit: 10 });
    report.searchCount = search.items?.length;
    report.stage = 'playlists'; const playlists = await api.request('playlists', { limit: 50 });
    report.playlistCount = playlists.items?.length; report.success = true; return;
  }
  report.state = 'expired';
}).catch(error => { report.success = false; report.error = /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'catalog-probe-failed'; })
  .finally(async () => { login?.clear(); delete report.authorizationUrl; report.finishedAt = new Date().toISOString(); await save(); app.quit(); });
