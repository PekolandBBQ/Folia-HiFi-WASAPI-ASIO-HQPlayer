const { app, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { createSpotifyService } = require('../../electron/spotify/service.cjs');
const { readClientSettings } = require('../../electron/spotify/clientSettings.cjs');

// User-facing fresh pairing only. Never reads another profile, imports a token or logs a credential.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(directory, 'electron-profile'));
let service;
const status = value => fs.writeFile(path.join(directory, 'pairing-status.json'), JSON.stringify(value, null, 2));
app.whenReady().then(async () => {
    await fs.mkdir(directory, { recursive: true });
    service = createSpotifyService({ directory: path.join(directory, 'spotify'), safeStorage,
        ...readClientSettings(path.join(directory, 'spotify')),
        nativeExecutable: path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe'),
        fetcher: (url, options) => net.fetch(url, options),
        renderQr: async url => {
            await status({ state: 'waiting', verificationUrl: url });
            await QRCode.toFile(path.join(directory, 'pairing.png'), url, { width: 320, margin: 2 });
            return QRCode.toDataURL(url);
        } });
    const key = await service.request({ action: 'loginBegin' });
    const deadline = Date.now() + 900000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = await service.request({ action: 'loginCheck', key });
        if (['waiting', 'scanned'].includes(result.state)) continue;
        await status({ state: result.state });
        if (result.state !== 'confirmed') return;
        try {
            const profile = await service.request({ action: 'status' });
            const playlists = await service.request({ action: 'playlists', limit: 20 });
            await status({ state: 'confirmed', profileAvailable: Boolean(profile?.id), premium: profile?.product === 'premium', playlistCount: playlists.items?.length });
        } catch (error) { await status({ state: 'confirmed', catalogAvailable: false, error: /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'request-failed' }); }
        return;
    }
    await status({ state: 'expired' });
}).catch(async error => {
    await fs.mkdir(directory, { recursive: true });
    await status({ state: 'failed', error: /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'request-failed' });
}).finally(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); await service?.close(); app.quit(); });
