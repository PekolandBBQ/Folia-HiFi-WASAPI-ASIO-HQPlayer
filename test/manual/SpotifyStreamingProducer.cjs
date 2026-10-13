const { app, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const { createNativeHost } = require('../../electron/spotify/nativeHost.cjs');
const { assertHello } = require('../../electron/spotify/componentProtocol.cjs');
const { createAudioPreparation } = require('../../electron/spotify/audioPreparation.cjs');

// Adapter-focused real authenticated producer check; does not count as audible app playback acceptance.
const root = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
app.setPath('userData', path.join(root, 'electron-profile'));
const httpMode = process.argv.includes('--http');
const encoded = process.argv.includes('--encoded') || httpMode;
const slot = process.argv.includes('--candidate-fallback') ? 'encoded-fallback-preview' : encoded ? 'encoded-streaming-preview' : 'streaming-preview';
const executable = path.resolve(__dirname, `../../build/spotify/${slot}/folia-spotify-playback.exe`);
const action = encoded ? 'audio-stream-encoded' : 'audio-stream';
const report = { startedAt: new Date().toISOString(), results: [], sourceEncodingVerified: encoded, producerAction: action };
let host, audio;

async function decodeHttp(quality) {
  const started = Date.now();
  const source = await audio.prepare('3n3Ppam7vgaVa1iaRUc9Lp', randomUUID(), undefined, quality, { streaming: true });
  const readyMs = Date.now() - started;
  assert.equal(source.sourceInfo.encodingVerified, true); assert.equal(source.sourceInfo.bitrate, quality === 'standard' ? 160000 : 320000);
  const response = await net.fetch(source.url);
  assert.equal(response.headers.get('content-type'), 'audio/ogg');
  const chunkedAtOpen = response.headers.get('content-length') === null;
  const reader = response.body.getReader(), hash = createHash('sha256'); let bytes = 0, firstBytes = 0;
  while (true) { const next = await reader.read(); if (next.done) break;
    if (!firstBytes) firstBytes = next.value.length; bytes += next.value.length; hash.update(next.value); }
  const completeMs = Date.now() - started;
  const whole = await audio.prepare('3n3Ppam7vgaVa1iaRUc9Lp', randomUUID(), undefined, quality);
  assert.equal(whole.url, source.url);
  const head = await net.fetch(source.url, { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), bytes);
  const range = await net.fetch(source.url, { headers: { Range: 'bytes=0-57' } }); assert.equal(range.status, 206);
  const header = Buffer.from(await range.arrayBuffer()); assert.equal(header.toString('ascii', 0, 4), 'OggS');
  const body = 27 + header[26]; assert.equal(header.readInt32LE(body + 20), source.sourceInfo.bitrate);
  assert.ok(chunkedAtOpen && readyMs < completeMs && firstBytes < bytes, 'Source was not served while still growing');
  return { requested: quality, returned: source.quality, actualQuality: source.actualQuality, sourceInfo: source.sourceInfo,
    earlySourceMs: readyMs, completedHttpMs: completeMs, chunkedAtOpen, firstChunkBytes: firstBytes, finalBytes: bytes,
    encodedSha256: hash.digest('hex'), finiteRangeAfterEof: true, success: true, cacheUrl: source.url };
}

async function decode(vault, quality) {
  const output = path.join(root, randomUUID() + (encoded ? '.ogg' : '.wav'));
  const accessToken = await vault.token();
  assert.ok(accessToken, 'Authenticated Spotify session required');
  const started = Date.now();
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const result = { requested: quality, requestedKbps: quality === 'standard' ? 160 : 320, stages: [] };
  let first, ready, failure, hello = false;
  const pending = [];
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill(), 225000);
  child.stdin.on('error', () => {});
  lines.on('line', line => {
    if (line.length > 4096) { failure = 'native-line-limit'; child.kill(); return; }
    let event; try { event = JSON.parse(line); } catch { failure = 'native-json'; child.kill(); return; }
    if (!hello) {
      try { assertHello(event, { action }); }
      catch { failure = 'native-incompatible'; child.kill(); return; }
      hello = true;
      child.stdin.end(JSON.stringify({ action, accessToken, trackId: '3n3Ppam7vgaVa1iaRUc9Lp', output, quality }) + '\n');
    } else if (event.event === 'stream-ready') {
      first = event;
      result.firstReadyMs = Date.now() - started;
      result.firstSamples = event.samples;
      if (encoded) result.source = event.source;
      result.processAliveAtFirstReady = child.exitCode === null;
      pending.push((async () => {
        const handle = await fs.open(output, 'r');
        try {
          const header = Buffer.alloc(128); await handle.read(header, 0, 128, 0);
          if (encoded) {
            assert.equal(header.toString('ascii', 0, 4), 'OggS');
            const body = 27 + header[26];
            assert.equal(header.toString('ascii', body + 1, body + 7), 'vorbis');
            result.deliveredNominalBitrate = header.readInt32LE(body + 20);
          } else { result.firstRiffSize = header.readUInt32LE(4); result.firstDataSize = header.readUInt32LE(40); }
          result.bytesAtFirstReady = (await handle.stat()).size;
        } finally { await handle.close(); }
      })());
    } else if (event.event === 'ready') { ready = event; result.finishedDecodeMs = Date.now() - started; }
    else if (event.event === 'failed') failure = event.code;
    else if (['connecting', 'connected', 'loading', 'metadata'].includes(event.event)) result.stages.push(event.event);
  });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  clearTimeout(timeout); lines.close(); await Promise.all(pending);
  try {
    assert.equal(code, 0, failure || 'Producer process failed');
    assert.ok(first && ready, 'Early and final readiness events required');
    assert.equal(first.quality, quality);
    const final = await fs.readFile(output);
    if (encoded) {
      assert.equal(first.source.sourceEncodingVerified, true);
      assert.equal(first.source.sourceEncoding, 'vorbis'); assert.equal(first.source.sourceContainer, 'ogg');
      assert.equal(result.deliveredNominalBitrate, result.requestedKbps * 1000);
      assert.equal(first.source.sourceBitrate, result.deliveredNominalBitrate);
      assert.equal(ready.bytes, final.length); assert.ok(ready.pcmFrames > first.pcmFrames);
      result.finalPcmFrames = ready.pcmFrames;
    } else {
      assert.equal(first.sourceEncodingVerified, false);
      assert.equal(final.length, 44 + ready.samples * 4);
      assert.equal(final.readUInt32LE(40), ready.samples * 4);
      assert.equal(result.firstDataSize, 0xffffffff, 'Early WAV header should keep length open');
      assert.ok(first.samples < ready.samples, 'Source was fully decoded before first ready');
    }
    assert.ok(result.processAliveAtFirstReady, 'Source finished before first ready');
    assert.ok(result.bytesAtFirstReady < final.length, 'Growing source did not expose an early prefix');
    result.finalSamples = ready.samples; result.finalBytes = final.length;
    result.decodedSha256 = createHash('sha256').update(final).digest('hex');
    result.representation = ready.representation; result.success = true;
    return result;
  } finally { await fs.rm(output, { force: true }); }
}

app.whenReady().then(async () => {
  const vault = createSessionVault({ directory: path.join(root, 'spotify'), safeStorage, fetcher: (url, options) => net.fetch(url, options) });
  host = createNativeHost({ vault, executable });
  const before = await host.request({ action: 'status' });
  report.loginBefore = Boolean(before?.id);
  report.reportedProduct = before?.product ?? null;
  report.premium = before?.product ? before.product === 'premium' : null;
  assert.ok(report.loginBefore);
  if (httpMode) {
    audio = createAudioPreparation({ directory: path.join(root, 'streaming-producer-cache'), native: host, vault });
    for (const quality of ['standard', 'high']) report.results.push(await decodeHttp(quality));
    const cached = await audio.prepare('3n3Ppam7vgaVa1iaRUc9Lp', randomUUID(), undefined, 'standard', { streaming: true });
    assert.equal(cached.url, report.results[0].cacheUrl); assert.notEqual(cached.url, report.results[1].cacheUrl);
    for (const result of report.results) delete result.cacheUrl;
    report.returnToStandardCacheVerified = true;
  } else {
    for (const quality of ['standard', 'high']) report.results.push(await decode(vault, quality));
    assert.notEqual(report.results[0].decodedSha256, report.results[1].decodedSha256, 'Requested quality variants decoded to the same data');
  }
  report.loginAfter = Boolean((await host.request({ action: 'status' }))?.id); assert.ok(report.loginAfter);
  report.success = true;
}).catch(error => { report.success = false; report.error = error.message; })
  .finally(async () => {
    await audio?.close(); host?.clear(); report.finishedAt = new Date().toISOString();
    const destination = path.join(root, `streaming-producer-${Date.now()}.json`);
    await fs.writeFile(destination, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); console.log('Report: ' + destination); app.quit();
  });
