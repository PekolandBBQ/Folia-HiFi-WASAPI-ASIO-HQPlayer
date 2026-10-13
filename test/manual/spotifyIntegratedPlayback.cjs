const { app, safeStorage, net, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createSpotifyService } = require('../../electron/spotify/service.cjs');
const { readClientSettings } = require('../../electron/spotify/clientSettings.cjs');

// Real provider-service playback; only the freshly authorized preview account and temporary media are used.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(directory, 'electron-profile'));
app.on('window-all-closed', () => {});
const report = { startedAt: new Date().toISOString(), progress: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let service, window;
app.whenReady().then(async () => {
  service = createSpotifyService({ directory: path.join(directory, 'spotify'), safeStorage, fetcher: (url, options) => net.fetch(url, options),
    nativeExecutable: path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe'),
    ...readClientSettings(path.join(directory, 'spotify')) });
  report.stage = 'profile'; const user = await service.request({ action: 'status' });
  assert.ok(user?.id); report.premium = user.product === 'premium';
  report.stage = 'search'; const search = await service.request({ action: 'search', query: 'Mr. Brightside', limit: 10 });
  assert.ok(search.items?.length); report.searchCount = search.items.length;
  report.stage = 'cancel'; const cancelledId = randomUUID();
  const cancelled = service.request({ action: 'audio', id: search.items[0].id, requestId: cancelledId });
  const rejected = assert.rejects(cancelled, /request-cancelled/);
  await service.request({ action: 'cancelAudio', requestId: cancelledId }); await rejected; report.cancelled = true;
  report.stage = 'prepare'; const started = Date.now();
  const source = await service.request({ action: 'audio', id: search.items[0].id, requestId: randomUUID() }, value => report.progress.push(value));
  report.prepareMs = Date.now() - started; report.songName = search.items[0].name;
  const range = await net.fetch(source.url, { headers: { Range: 'bytes=0-43' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 44); report.rangePassed = true;
  const cachedStart = Date.now();
  const cached = await service.request({ action: 'audio', id: search.items[0].id, requestId: randomUUID() });
  assert.equal(cached.url, source.url); report.cacheMs = Date.now() - cachedStart;
  report.stage = 'playback';
  const html = path.join(directory, 'integrated-playback.html');
  await fs.writeFile(html, '<!doctype html><meta charset="utf-8"><title>Spotify integration verification</title><audio></audio>');
  window = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', contextIsolation: true, sandbox: true } });
  await window.loadFile(html);
  await window.webContents.executeJavaScript(`window.a=document.querySelector('audio'); a.volume=0.02; a.src=${JSON.stringify(source.url)}; a.play()`);
  await delay(2500); report.playingAt = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(report.playingAt > 1);
  await window.webContents.executeJavaScript('a.pause(); a.currentTime=40'); await delay(300);
  report.pausedAt = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(Math.abs(report.pausedAt - 40) < .5);
  await window.webContents.executeJavaScript('a.play()'); await delay(1600);
  report.resumedAt = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(report.resumedAt > 41);
  await window.webContents.executeJavaScript('a.pause(); a.removeAttribute("src"); a.load()');
  await service.close();
  report.revoked = await net.fetch(source.url).then(response => response.status !== 200 && response.status !== 206, () => true);
  assert.equal(report.revoked, true); report.success = true;
}).catch(error => { report.success = false; report.error = error.code || (/^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'integration-assertion-failed'); })
  .finally(async () => { window?.destroy(); await service?.close(); report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, `integrated-${Date.now()}.json`), JSON.stringify(report, null, 2)); app.quit(); });
