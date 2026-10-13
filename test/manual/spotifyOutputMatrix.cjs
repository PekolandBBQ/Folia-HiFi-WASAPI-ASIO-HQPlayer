const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createHelper } = require('../../electron/nativeAudio/helper.cjs');
const { decodeLocalAudio } = require('../../electron/nativeAudio/decode.cjs');
const { createHQPlayerHost } = require('../../../folia-hqplayer-component/src/hqplayerHost.cjs');

// Opt-in real hardware playback of freshly decoded Spotify media; never modifies Folia preferences.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(directory, 'output-profile'));
app.on('window-all-closed', () => {}); // Keep the sequential hardware matrix alive after the browser deck closes.
const report = { startedAt: new Date().toISOString(), results: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (test()) return; await delay(100); }
  throw new Error('Playback clock did not reach the expected state');
}
async function record(mode, run) {
  if (process.argv.includes('--native-only') && !['wasapi-exclusive', 'asio'].includes(mode)) return;
  const started = Date.now();
  try { report.results.push({ mode, pass: true, ...await run(), elapsedMs: Date.now() - started }); }
  catch (error) { report.results.push({ mode, pass: false, error: error.message, elapsedMs: Date.now() - started }); }
}
app.whenReady().then(async () => {
  const reports = (await fs.readdir(directory)).filter(file => /^audio-\d+\.json$/.test(file)).sort().reverse();
  const source = JSON.parse(await fs.readFile(path.join(directory, reports[0]), 'utf8'));
  assert.equal(source.success, true, 'Fresh Spotify decoding must pass first');
  const input = source.output;
  report.source = { name: source.events.find(event => event.event === 'metadata')?.name, duration: 222.2, quality: 'Spotify decoded PCM; source lossless quality not asserted' };
  await record('browser', async () => {
    const html = path.join(directory, 'output-probe.html');
    await fs.writeFile(html, '<!doctype html><meta charset="utf-8"><title>Folia Spotify playback test</title><audio></audio>');
    const window = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', contextIsolation: true, sandbox: true } });
    try {
      await window.loadFile(html);
      await window.webContents.executeJavaScript(`window.a=document.querySelector('audio'); a.volume=0.02; a.src=${JSON.stringify(pathToFileURL(input).href)}; a.play()`);
      await delay(2500);
      const start = await window.webContents.executeJavaScript('({playing:!a.paused,position:a.currentTime,duration:a.duration,error:a.error?.code})');
      assert.ok(start.playing && start.position > 1 && !start.error);
      await window.webContents.executeJavaScript('a.pause(); a.currentTime=40'); await delay(300);
      const paused = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(Math.abs(paused - 40) < .5);
      await delay(400); assert.equal(await window.webContents.executeJavaScript('a.currentTime'), paused);
      await window.webContents.executeJavaScript('a.play()'); await delay(1600);
      const resumed = await window.webContents.executeJavaScript('a.currentTime'); assert.ok(resumed > 41);
      return { start, paused, resumed };
    } finally { window.destroy(); }
  });
  const prepared = path.join(directory, `native-${Date.now()}`); await fs.mkdir(prepared);
  const decoded = await decodeLocalAudio(path.resolve(process.env.FOLIA_NATIVE_FFMPEG_PATH || 'build/ffmpeg/win-x64/ffmpeg.exe'), input, prepared, new AbortController().signal);
  let latest, failure;
  const helper = createHelper(path.resolve('../folia-native-audio-component/artifacts/publish/folia-audio.exe'), event => {
    if (event.state) latest = event.state; if (event.event === 'error') failure = event.errorCode;
  });
  try {
    const devices = (await helper.request({ action: 'devices' })).filter(device => device.name.includes('XingCore'));
    for (const backend of ['wasapi-exclusive', 'asio']) await record(backend, async () => {
      const device = devices.find(device => device.backend === backend); assert.ok(device, 'Requested real output device must be present');
      const session = `spotify-${backend}`, request = (action, extra = {}) => helper.request({ action, session, ...extra });
      latest = undefined; failure = undefined;
      try {
        await request('load', { path: decoded, backend, deviceId: device.id, processingMode: 'compatibility' });
        await request('volume', { volume: .02 }); await request('play');
        await waitFor(() => latest?.playing && latest.position > 1);
        const start = latest.position;
        await request('pause'); const paused = await request('seek', { position: 40 }); assert.equal(paused.playing, false);
        // Paused seeks return an authoritative command response; no periodic state event is emitted while paused.
        assert.equal(paused.position, 40);
        await delay(350); const stillPaused = await request('pause');
        assert.equal(stillPaused.position, 40); assert.equal(stillPaused.playing, false);
        await request('play'); await waitFor(() => latest?.playing && latest.position > 41);
        assert.equal(failure, undefined);
        return { device: device.name, start, paused: paused.position, resumed: latest.position };
      } finally { await request('stop').catch(() => {}); }
    });
  } finally { helper.dispose(); }
  for (const silent of [false, true]) await record(silent ? 'hqplayer-silent' : 'hqplayer-foreground', async () => {
    let state, fault; const diagnostics = [];
    const host = createHQPlayerHost({ onState: value => { state = value; }, onError: value => { fault = value.code; }, onDiagnostic: value => diagnostics.push(value) });
    host.setSilent(silent); const session = `spotify-hq-${silent}`;
    try {
      // Output-switch cleanup is user-authorized; any existing instance is closed before this test.
      await host.shutdown();
      await host.load({ session, filePath: input, gainDb: -35, trackKey: session });
      await host.command(session, 'play'); await waitFor(() => state?.playing && state.position > 1, 45000);
      const start = state.position;
      await host.command(session, 'pause'); await host.command(session, 'seek', 40); await delay(500);
      await host.command(session, 'play'); await waitFor(() => state?.playing && state.position > 41, 45000);
      assert.equal(fault, undefined);
      return { start, resumed: state.position, outputFormat: state.outputFormat, diagnostics, silentRequested: silent };
    } finally { await host.shutdown(); host.dispose(); }
  });
  await fs.rm(prepared, { recursive: true, force: true });
}).catch(error => { report.error = error.message; }).finally(async () => {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, `output-matrix-${Date.now()}.json`), JSON.stringify(report, null, 2));
  app.quit();
});
