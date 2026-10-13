import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { helper, decodeStream, sleep } from '../../../folia-native-audio-component/experiments/streaming/probeSupport.mjs';

// Explicit cross-provider experiment: verified Omni logins/URLs, then a native streaming clip.
// This is not acceptance of app UI, end-to-end seek, original-quality entitlement or HQPlayer.
const root = path.resolve('..');
const ffmpeg = path.join(root, 'artifacts/Folia-HiFi-0.7.12-final/win-unpacked/resources/ffmpeg-audio/ffmpeg.exe');
const transport = helper(path.join(root, 'folia-native-audio-component/experiments/streaming/bin/Release/net8.0-windows/folia-streaming-prototype.exe'));
const report = { started: new Date().toISOString(), scope: 'authenticated-provider-native-streaming-clips', results: [] };
const application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000 });
try {
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    page = application.windows().find(window => window.url().startsWith('http://localhost:3000'));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('Preview unavailable');
  await page.waitForTimeout(10000);
  const devices = await transport.rpc('devices');
  const login = provider => page.evaluate(async provider => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    return Boolean((await omni.getLoginStatus(provider))?.id);
  }, provider);
  for (const [provider, query] of [['netease', 'HIMEHINA'], ['qq', '许嵩']].filter(([id]) => !process.env.FOLIA_TEST_PROVIDER || id === process.env.FOLIA_TEST_PROVIDER)) {
    const authenticatedBefore = await login(provider);
    if (!authenticatedBefore) { report.results.push({ provider, passed: false, reason: 'login-required' }); continue; }
    const searchLimit = Number(process.env.FOLIA_TEST_SEARCH_LIMIT || 30);
    const candidates = await page.evaluate(async ({ provider, query, searchLimit }) => {
      const { omni } = await import('/src/services/onlineMusic/omni.ts');
      const result = await omni.searchProviderSongs(provider, query, { limit: searchLimit, offset: 0 });
      window.nativeStreamCandidates = result.items;
      return result.items.map(song => ({ id: song.id, name: song.name }));
    }, { provider, query, searchLimit });
    report.searches ||= []; report.searches.push({ provider, searchLimit, candidates });
    console.log(JSON.stringify({ provider, searchLimit, searchCount: candidates.length }));
    let selectedIndex = -1;
    for (const quality of ['standard', 'lossless']) {
      // Signed audio URL stays in memory. Report records public metadata only.
      const source = await page.evaluate(async ({ quality, selectedIndex }) => {
        const { omni } = await import('/src/services/onlineMusic/omni.ts');
        const songs = window.nativeStreamCandidates || [];
        const indices = selectedIndex >= 0 ? [selectedIndex] : songs.slice(0, 8).map((_, index) => index);
        const attempts = [];
        for (const index of indices) {
          try { const source = await omni.getAudioSource(songs[index], quality);
            attempts.push({ id: songs[index].id, available: Boolean(source?.url), hasMediaMid: Boolean(songs[index].sourceRef?.providerData?.mediaMid) });
            if (source?.url) return { index, url: source.url, returnedQuality: source.quality, attempts };
          } catch (error) { attempts.push({ id: songs[index].id, errorCode: error.code || 'source-failed' }); }
        }
        return { attempts };
      }, { quality, selectedIndex });
      if (!source?.url) { const failure = { provider, quality, passed: false, reason: 'source-unavailable', searchCount: candidates.length, attempts: source?.attempts }; report.results.push(failure); console.log(JSON.stringify(failure)); continue; }
      selectedIndex = source.index;
      for (const backend of ['wasapi-exclusive', 'asio']) {
        const device = devices.find(item => item.backend === backend && /XingCore/i.test(item.name));
        const result = { provider, requestedQuality: quality, returnedQuality: source.returnedQuality,
          song: candidates[selectedIndex], backend, authenticatedBefore, passed: false };
        const controller = new AbortController();
        const fields = { session: `${provider}-${quality}-${backend}`, generation: 0 };
        const rpc = (action, args) => transport.rpc(action, { ...fields, ...args });
        let opened = false; let started = false; let bytes = 0; let error; let producerDone = false;
        const begin = performance.now();
        const producer = decodeStream({ ffmpeg, url: source.url, signal: controller.signal,
          onBytes: size => { bytes += size; },
          onResponse: info => { result.response = info; },
          onInputFormat: value => { result.originalEncoding = value; },
          push: async (pcm, format) => {
            controller.signal.throwIfAborted();
            if (!opened) {
              assert.ok(device, 'XingCore device not available');
              await rpc('open', { backend, deviceId: device.id, rate: format.rate, channels: format.channels });
              await rpc('volume', { volume: 0.02 }); // Safe listening level for real music.
              opened = true; result.decodedFormat = format;
            }
            let accepted;
            do {
              controller.signal.throwIfAborted();
              accepted = await rpc('push', { pcm: pcm.toString('base64') });
              if (!accepted.accepted) await sleep(25);
            } while (!accepted.accepted);
            if (!started && accepted.state.bufferedSeconds >= 0.35) {
              await rpc('play'); started = true;
              result.playCommandMs = Math.round(performance.now() - begin);
              result.bytesAtPlay = bytes;
              result.downloadFractionAtPlay = result.response.totalBytes ? bytes / result.response.totalBytes : null;
            }
          }
        }).then(async () => { producerDone = true; if (opened) await rpc('complete'); })
          .catch(failure => { if (!controller.signal.aborted) error = failure; });
        try {
          while (performance.now() - begin < 30000) {
            if (error) throw error;
            if (started) {
              const state = await rpc('status'); assert.equal(state.error, null);
              if (state.consumedPosition >= 5) {
                result.final = state; result.transferredBytes = bytes; result.producerFinishedAtStop = producerDone;
                result.authenticatedAfter = await login(provider);
                assert.ok(result.authenticatedAfter);
                assert.ok(result.downloadFractionAtPlay !== null && result.downloadFractionAtPlay < 1, 'No evidence of starting before complete download');
                result.passed = true; break;
              }
            }
            await sleep(100);
          }
          if (!result.passed) throw new Error('Native streaming clip timed out');
        } catch (failure) { result.error = failure.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]'); }
        finally {
          controller.abort(); await producer;
          if (opened) await rpc('stop').catch(() => {});
        }
        report.results.push(result); console.log(JSON.stringify(result));
      }
    }
  }
} catch (error) { report.error = error.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]'); }
finally {
  transport.close(); await application.close();
  const folder = path.join(root, 'artifacts/native-streaming-20261002'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `authenticated-clips-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2)); console.log(file);
}
if (report.error || report.results.length !== (process.env.FOLIA_TEST_PROVIDER ? 4 : 8) || report.results.some(result => !result.passed)) process.exitCode = 1;
