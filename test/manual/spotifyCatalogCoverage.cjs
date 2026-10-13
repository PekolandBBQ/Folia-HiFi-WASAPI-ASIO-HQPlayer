const { app, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createSpotifyService } = require('../../electron/spotify/service.cjs');
const { readClientSettings } = require('../../electron/spotify/clientSettings.cjs');

// Read-only catalog coverage using this task's fresh grant; reports contain no tokens or stream URLs.
const root = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(root, 'electron-profile'));
const report = { startedAt: new Date().toISOString(), stages: [] }; let service;
app.whenReady().then(async () => {
  const directory = path.join(root, 'spotify');
  service = createSpotifyService({ directory, safeStorage, ...readClientSettings(directory),
    fetcher: (url, options) => net.fetch(url, options), nativeExecutable: path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe') });
  const profile = await service.request({ action: 'status' }); assert.ok(profile?.id);
  const collections = []; let offset = 0, more = true;
  for (let count = 0; more && count < 10; count++) {
    const page = await service.request({ action: 'playlists', offset, limit: 2 });
    assert.ok(Array.isArray(page.items)); collections.push(...page.items);
    const consumed = page.consumed ?? page.items.length;
    report.stages.push({ stage: 'root-page', offset, returned: page.items.length, consumed, more: page.next });
    more = Boolean(page.next); if (more) assert.ok(consumed > 0); offset += consumed;
  }
  assert.equal(more, false); assert.equal(new Set(collections.map(item => item.id)).size, collections.length);
  report.playlists = collections.length; assert.ok(collections.length);
  const detail = await service.request({ action: 'playlist', id: collections[0].id }); assert.ok(detail.name);
  const first = await service.request({ action: 'playlistTracks', id: collections[0].id, limit: 7, offset: 0 });
  const second = await service.request({ action: 'playlistTracks', id: collections[0].id, limit: 7, offset: first.consumed });
  assert.ok(first.items.length && second.items.length);
  assert.ok(first.items.every(item => item.name && item.artists?.length && item.album?.id));
  assert.notDeepEqual(first.items.map(item => item.id), second.items.map(item => item.id));
  report.stages.push({ stage: 'playlist-pages', total: first.total, counts: [first.items.length, second.items.length] });
  const albumId = first.items[0].album.id;
  const album = await service.request({ action: 'album', id: albumId }); assert.ok(album.name && album.total_tracks > 0);
  const tracks = await service.request({ action: 'albumTracks', id: albumId, limit: 7 });
  assert.ok(tracks.items.length && tracks.items.every(item => item.name && item.duration_ms > 0));
  report.stages.push({ stage: 'album', total: album.total_tracks, returned: tracks.items.length, covers: album.images?.length || 0 });
  const cover = album.images?.[0]?.url;
  if (cover) { const response = await net.fetch(cover, { method: 'HEAD' }); report.coverStatus = response.status; assert.ok(response.ok); }
  report.success = true;
}).catch(error => { report.success = false; report.error = String(error.message).slice(0, 250); })
  .finally(async () => { await service?.close(); report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(root, `catalog-coverage-${Date.now()}.json`), JSON.stringify(report, null, 2)); app.quit(); });
