const { app, safeStorage, net, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createSpotifyService } = require('../../electron/spotify/service.cjs');
const { readClientSettings } = require('../../electron/spotify/clientSettings.cjs');

// Real authenticated quality changes: compare decoded bytes and cache reuse, not PCM container bit depth.
const root = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(root, 'electron-profile'));
app.on('window-all-closed', () => {});
const report = { startedAt: new Date().toISOString(), results: [] };
let service, window;
app.whenReady().then(async () => {
  const directory = path.join(root, 'spotify');
  service = createSpotifyService({ directory, safeStorage, ...readClientSettings(directory), fetcher: (url, options) => net.fetch(url, options),
    nativeExecutable: path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe') });
  report.loginBefore = Boolean((await service.request({ action: 'status' }))?.id); assert.ok(report.loginBefore);
  const search = await service.request({ action: 'search', query: 'Mr. Brightside', limit: 10 });
  const id = search.items[0].id; report.song = search.items[0].name;
  const html = path.join(root, 'quality-playback.html'); await fs.writeFile(html, '<!doctype html><title>Quality validation</title><audio></audio>');
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
  await window.loadFile(html); const urls = [];
  for (const quality of ['standard', 'high', 'standard']) {
    const started = Date.now();
    const source = await service.request({ action: 'audio', id, quality, requestId: randomUUID() });
    const bytes = Buffer.from(await (await net.fetch(source.url)).arrayBuffer());
    const result = { requested: quality, returned: source.quality, prepareMs: Date.now() - started,
      decodedSha256: createHash('sha256').update(bytes).digest('hex'), decodedBytes: bytes.length,
      requestedKbps: quality === 'standard' ? 160 : 320, originalEncodingVerified: false };
    assert.equal(source.quality, quality); urls.push(source.url);
    await window.webContents.executeJavaScript(`window.a=document.querySelector('audio'); a.volume=.02; a.src=${JSON.stringify(source.url)}; a.play()`);
    await new Promise(resolve => setTimeout(resolve, 1800));
    result.playingAt = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(result.playingAt > 1);
    await window.webContents.executeJavaScript('a.pause()'); report.results.push(result);
  }
  assert.notEqual(urls[0], urls[1]); assert.equal(urls[0], urls[2]);
  assert.notEqual(report.results[0].decodedSha256, report.results[1].decodedSha256);
  assert.equal(report.results[0].decodedSha256, report.results[2].decodedSha256);
  report.unsupported = [];
  for (const quality of ['lossless', 'hires']) {
    await assert.rejects(service.request({ action: 'audio', id, quality, requestId: randomUUID() }), /quality-unsupported/);
    report.unsupported.push(quality);
  }
  report.loginAfter = Boolean((await service.request({ action: 'status' }))?.id); assert.ok(report.loginAfter);
  report.success = true;
}).catch(error => { report.success = false; report.error = error.message; })
  .finally(async () => { window?.destroy(); await service?.close(); report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(root, `quality-playback-${Date.now()}.json`), JSON.stringify(report, null, 2)); app.quit(); });
