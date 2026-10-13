const { app, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createSpotifyService } = require('../../electron/spotify/service.cjs');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const { readClientSettings } = require('../../electron/spotify/clientSettings.cjs');

// Uses only the fresh account explicitly paired through spotifyFreshLogin in this preview profile.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(directory, 'electron-profile'));
const mode = process.argv.includes('--library') ? 'library' : process.argv.includes('--audio') ? 'audio' : 'catalog';
const report = { mode, startedAt: new Date().toISOString(), events: [] };
let service;
app.whenReady().then(async () => {
  const options = { directory: path.join(directory, 'spotify'), safeStorage, fetcher: (url, options) => net.fetch(url, options) };
  if (mode === 'catalog') {
    service = createSpotifyService({ ...options, ...readClientSettings(options.directory), nativeExecutable: path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe'), diagnostic: event => report.events.push(event) });
    report.stage = 'profile';
    const profile = await service.request({ action: 'status' });
    report.profileAvailable = Boolean(profile?.id); report.premium = profile?.product === 'premium';
    report.stage = 'playlists';
    const playlists = await service.request({ action: 'playlists', limit: 20 });
    report.playlistCount = playlists.items?.length;
    if (playlists.items?.length) {
      report.stage = 'playlist-tracks';
      const tracks = await service.request({ action: 'playlistTracks', id: playlists.items[0].id, limit: 50 });
      report.trackCount = tracks.items?.length;
      report.tracksNamed = tracks.items?.every(track => Boolean(track.name && track.artists?.length));
    }
    report.success = Boolean(profile?.id);
    return;
  }
  const vault = createSessionVault(options);
  const accessToken = await vault.token();
  if (!accessToken) throw new Error('Spotify: auth-required');
  const output = path.join(directory, `playback-${Date.now()}.wav`);
  const helper = path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe');
  const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    // The helper never emits credentials, CDN URLs or keys; preserve bounded typed diagnostics only.
    if (line.length > 4096 || report.events.length >= 50) return;
    try {
      const event = JSON.parse(line);
      if (['connecting', 'connected', 'loading', 'decoding', 'metadata', 'ready', 'failed', 'library'].includes(event.event)) report.events.push(event);
    } catch { /* Non-protocol output is discarded. */ }
  });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timeout = setTimeout(() => child.kill(), 230000);
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ action: mode, accessToken, trackId: '3n3Ppam7vgaVa1iaRUc9Lp', output }) + '\n');
  try { report.exitCode = await finished; } finally { clearTimeout(timeout); lines.close(); }
  report.success = report.exitCode === 0 && report.events.some(event => event.event === (mode === 'library' ? 'library' : 'ready'));
  if (report.success && mode === 'audio') report.output = output;
  else await fs.rm(output, { force: true });
}).catch(error => {
  report.success = false;
  report.error = /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'probe-failed';
  if (Number.isFinite(error.retryAt)) report.retryAt = error.retryAt;
}).finally(async () => {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, `${mode}-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await service?.close(); app.quit();
});
