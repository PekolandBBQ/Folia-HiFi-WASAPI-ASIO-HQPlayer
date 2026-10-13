import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyCurrentDsp, checkOutputLifecycle } from './streamingOutputLifecycle.mjs';
import { assertLiveFoliaDevServer, assertColdFoliaModuleGraph, observeFreshFoliaModuleGraph, unregisterPreviewServiceWorkers, submitHomeSearch } from './foliaAppTestReadiness.mjs';
import { inspectCurrentBrowserSource, assertEncodedQuality, assertNativeSourceFacts, findQualityReferenceIndex } from './streamingQualityEvidence.mjs';
import { nativeRendererErrors, assertNoNativeRendererErrors } from './nativeRendererErrorGate.mjs';
import { qqSearchResponseEvidence } from './qqSearchResponseEvidence.mjs';

// Real app, real streaming services and real DAC. Uses only the isolated preview profile.
const { hqplayerWindowState, assertHQPlayerWindowVisibility } = createRequire(import.meta.url)('./hqplayerWindowState.cjs');
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const quality = process.env.FOLIA_TEST_QUALITY || 'standard';
if (!['standard', 'high', 'lossless', 'hires'].includes(quality)) throw new Error('Invalid test quality');
const qualities = (process.env.FOLIA_TEST_QUALITIES || quality).split(',');
if (qualities.some(value => !['standard', 'high', 'lossless', 'hires'].includes(value))) throw new Error('Invalid test quality ladder');
const matrixKind = process.env.FOLIA_TEST_MATRIX_KIND || 'full';
if (!['full', 'quality', 'paused-seek'].includes(matrixKind)) throw new Error('Invalid test matrix kind');
const pausedBackends = (process.env.FOLIA_TEST_BACKENDS || 'wasapi-exclusive,asio,hqplayer,browser').split(',');
if (matrixKind === 'paused-seek' && (new Set(pausedBackends).size !== pausedBackends.length
    || pausedBackends.some(backend => !['wasapi-exclusive', 'asio', 'hqplayer', 'browser'].includes(backend))))
  throw new Error('Invalid paused-seek output selection');
const report = { startedAt: new Date().toISOString(), matrixKind, qualities, results: [], qqSearchNetwork: [] };
const qqNetworkPending = new Set(); let qqFailureCompared = false;
const cases = [['spotify', 'Mr. Brightside'], ['netease', 'HIMEHINA'], ['qq', '许嵩']]
  .filter(([provider]) => !process.env.FOLIA_TEST_PROVIDER || process.env.FOLIA_TEST_PROVIDER === provider)
  .flatMap(([provider, query]) => qualities.map(tier => [provider, process.env.FOLIA_TEST_QUERY || query, tier]));
const application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000,
  env: { ...process.env,
    FOLIA_NATIVE_COMPONENT_CATALOG: process.env.FOLIA_NATIVE_COMPONENT_CATALOG || path.resolve('../folia-native-audio-component/artifacts/development-catalog.json'),
    FOLIA_HQPLAYER_COMPONENT_CATALOG: process.env.FOLIA_HQPLAYER_COMPONENT_CATALOG || path.resolve('../folia-hqplayer-component/artifacts/development-catalog.json'),
    FOLIA_NATIVE_FFMPEG_PATH: path.resolve('../artifacts/Folia-HiFi-0.7.12-final/win-unpacked/resources/ffmpeg-audio/ffmpeg.exe') } });
let page;
const checkLogin = provider => page.evaluate(async provider => {
  const { omni } = await import('/src/services/onlineMusic/omni.ts');
  if (provider === 'netease') {
    const { neteaseApi: api } = await import('/src/services/netease.ts');
    const { readProviderSessionValue } = await import('/src/services/onlineMusic/providerStorage.ts');
    const { checkNeteaseLoginWithEvidence } = await import('/test/manual/neteaseLoginEvidence.mjs');
    return checkNeteaseLoginWithEvidence({ omni, api, readSession: () => readProviderSessionValue('netease', 'cookie', ['netease_cookie']) });
  }
  try {
    const user = await omni.getLoginStatus(provider);
    return { authenticated: Boolean(user?.id), checkedAt: new Date().toISOString() };
  } catch (error) {
    return { authenticated: false, checkedAt: new Date().toISOString(), errorCode: error.code || 'login-check-failed' };
  }
}, provider);
const snapshot = () => page.evaluate(() => {
  const q = window.outputRegression, state = q.player.getState(), last = q.events.filter(event => event.state).at(-1)?.state;
  return { song: state.currentSong?.name, id: state.currentSong?.id, provider: state.currentSong?.sourceRef?.providerId,
    playing: state.playerState, position: q.clock.get(), backend: q.settings.getState().nativeAudioBackend,
    native: last, errors: q.events.filter(event => event.event === 'error').map(event => event.errorCode),
    handoff: q.readOutputHandoffDiagnostics?.(),
    browser: [...document.querySelectorAll('audio')].filter(audio => !audio.paused).map(audio => audio.currentTime),
    browserDetails: [...document.querySelectorAll('audio')].map(audio => ({ currentSource: audio.getAttribute('src') === state.audioSrc,
      position: audio.currentTime, duration: audio.duration, paused: audio.paused, seeking: audio.seeking,
      readyState: audio.readyState, networkState: audio.networkState, errorCode: audio.error?.code })),
    ...(q.mediaTrace ? { mediaTrace: q.mediaTrace.slice(-100) } : {}) };
});
try {
  await assertLiveFoliaDevServer();
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    page = application.windows().find(window => window.url().startsWith('http://localhost:3000'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Folia app window did not open');
  const qqSearchRequests = new Map();
  page.on('request', async request => {
    if (!request.url().startsWith('https://u.y.qq.com/cgi-bin/musicu.fcg')) return;
    let body; try { body = request.postDataJSON(); } catch { return; }
    if (body?.request?.module !== 'music.search.SearchCgiService' || body?.request?.method !== 'DoSearchForQQMusicLite') return;
    const params = body.request.param || {}, currentCase = report.results.at(-1);
    // Public anonymous catalog fields only. Never retain raw Cookie headers or authentication payloads.
    const entry = { at: new Date().toISOString(), caseIndex: report.results.length - 1,
      quality: currentCase?.quality, query: String(params.query || ''), page: params.page_num, limit: params.num_per_page,
      remoteplace: params.remoteplace, searchIdLength: String(params.search_id || '').length,
      anonymousUid: String(body.comm?.uid || '') === '0' };
    const commKeys = ['ct', 'cv', 'v', 'os_ver', 'phonetype', 'rom', 'tmeAppID', 'nettype', 'udid', 'uid'];
    const paramKeys = ['search_id', 'remoteplace', 'query', 'search_type', 'num_per_page', 'page_num', 'highlight', 'nqc_flag', 'page_id', 'grp'];
    const publicPayload = entry.anonymousUid && String(body.comm?.udid) === '0'
      && Object.keys(body).every(key => ['comm', 'request'].includes(key))
      && Object.keys(body.comm).every(key => commKeys.includes(key))
      && Object.keys(body.request).every(key => ['method', 'module', 'param'].includes(key))
      && Object.keys(params).every(key => paramKeys.includes(key));
    const rawBody = publicPayload ? request.postData() : null;
    if (rawBody) {
      entry.publicPayload = body; entry.publicPayloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    }
    const record = { entry, rawBody, isCaseSearch: currentCase?.provider === 'qq' && params.query === currentCase.query && !currentCase.search };
    qqSearchRequests.set(request, record); report.qqSearchNetwork.push(entry);
    if (report.qqSearchNetwork.length > 50) report.qqSearchNetwork.shift();
    record.publicHeaders = (async () => { try {
      const headers = await request.allHeaders();
      entry.transport = { userAgent: headers['user-agent'], hasCookie: Boolean(headers.cookie),
        anonymousCookiePresent: /(?:^|;\s*)tmeLoginType=-1(?:;|$)/.test(headers.cookie || ''),
        contentType: headers['content-type'], originPresent: Boolean(headers.origin), refererPresent: Boolean(headers.referer) };
      return Object.fromEntries(['content-type', 'user-agent', 'origin', 'referer', 'accept', 'accept-language',
        'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].filter(key => headers[key]).map(key => [key, headers[key]]));
    } catch { entry.transportUnavailable = true; return {}; } })();
  });
  page.on('response', response => {
    const record = qqSearchRequests.get(response.request()); if (!record) return;
    qqSearchRequests.delete(response.request()); const { entry } = record; entry.httpStatus = response.status();
    const pending = (async () => { try {
      const body = await response.json(), songs = body?.request?.data?.body?.item_song;
      Object.assign(entry, qqSearchResponseEvidence(body, await response.allHeaders()));
      entry.songCount = Array.isArray(songs) ? songs.length : null;
      entry.referenceFound = Array.isArray(songs) && songs.some(song => Number(song.id) === 1531817);
      if (record.isCaseSearch && record.rawBody && !qqFailureCompared && (entry.code === 2001 || entry.requestCode === 2001)) {
        qqFailureCompared = true;
        // One diagnostic replay of the exact anonymous public body/public headers only.
        // Its result never alters the original failing UI case or enables another acceptance retry.
        try {
          const compared = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST',
            headers: await record.publicHeaders, body: record.rawBody, signal: AbortSignal.timeout(15000) });
          const other = await compared.json(), items = other?.request?.data?.body?.item_song;
          entry.nodeDiagnostic = { scope: 'same-public-body-and-public-headers-without-cookies', count: 1,
            originalCaseRemainsFailed: true, bodySha256: entry.publicPayloadSha256, httpStatus: compared.status,
            ...qqSearchResponseEvidence(other, Object.fromEntries(compared.headers)),
            songCount: Array.isArray(items) ? items.length : null, referenceFound: Array.isArray(items) && items.some(song => Number(song.id) === 1531817) };
        } catch (error) { entry.nodeDiagnostic = { count: 1, originalCaseRemainsFailed: true, error: error.message }; }
      }
    } catch { entry.responseUnreadable = true; } })();
    qqNetworkPending.add(pending); void pending.finally(() => qqNetworkPending.delete(pending));
  });
  page.setDefaultTimeout(30000);
  report.unregisteredPreviewWorkers = await unregisterPreviewServiceWorkers(page);
  await page.evaluate(() => {
    for (const [key, value] of Object.entries({ i18nextLng: 'en', folia_last_seen_ponder_onboarding_version: '0.7.12',
      static_mode: 'true', open_player_on_launch: 'false', player_volume: '0.02', folia_native_audio_backend: 'browser', folia_native_audio_device: '',
      folia_native_audio_auto_fallback: 'false', folia_hqplayer_gain_db: '-35', folia_hqplayer_dsp_defaults: 'null' })) localStorage.setItem(key, value);
  });
  await observeFreshFoliaModuleGraph(page); await page.waitForTimeout(15000);
  report.runtimeIdentity = await assertColdFoliaModuleGraph(page);
  if (!report.runtimeIdentity.completeResourceObservation) throw new Error('Fresh Folia module graph observation is missing');
  // Authentication is a prerequisite, not a playback failure. Never use anonymous results for acceptance.
  const authenticatedCases = [];
  report.authentication = {};
  for (const [provider, query, quality] of cases) {
    const login = await checkLogin(provider); report.authentication[provider] = login;
    if (login.authenticated) authenticatedCases.push([provider, query, quality]);
    else report.results.push({ provider, query, quality, pass: false, outcome: 'blocked-login', stages: [],
      error: 'A valid signed-in account is required before playback acceptance testing' });
  }
  if (!authenticatedCases.length) throw new Error('Playback tests not started: no selected provider has a verified login');
  await page.evaluate(async () => {
    const { usePlaybackStore: player } = await import('/src/stores/usePlaybackStore.ts');
    const { useAudioSettingsStore: settings } = await import('/src/stores/useAudioSettingsStore.ts');
    const { useHQPlayerSettingsStore: hqp } = await import('/src/stores/useHQPlayerSettingsStore.ts');
    const { currentTime: clock } = await import('/src/stores/motionSignals.ts');
    const { useSearchNavigationStore: search } = await import('/src/stores/useSearchNavigationStore.ts');
    const { useAppViewStore: view } = await import('/src/stores/useAppViewStore.ts');
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    const { getAudioSourceMetadata } = await import('/src/services/onlineMusic/audioSourceQuality.ts');
    const { readOutputHandoffDiagnostics } = await import('/src/services/nativeAudio/outputHandoff.ts');
    const qualityRequests = [], sourceTags = new Map(), getAudioSource = omni.getAudioSource.bind(omni);
    const sourceTag = url => { if (!sourceTags.has(url)) sourceTags.set(url, `source-${sourceTags.size + 1}`); return sourceTags.get(url); };
    omni.getAudioSource = async (song, quality, options) => {
      const entry = { sequence: qualityRequests.length, startedAt: new Date().toISOString(), provider: song.sourceRef?.providerId,
        id: song.id, mediaId: String(song.sourceRef?.mediaId ?? song.id), requested: quality }; qualityRequests.push(entry);
      try {
        const source = await getAudioSource(song, quality, options);
        entry.returned = source?.quality; entry.available = Boolean(source?.url);
        entry.sourceTag = source?.url ? sourceTag(source.url) : undefined; entry.providerLevel = source?.providerLevel;
        entry.sourceFormat = source?.sourceFormat; entry.preparedAudio = source?.preparedAudio; entry.streaming = source?.streaming;
        return source;
      } catch (error) { entry.errorCode = error.code || 'request-failed'; throw error; }
    };
    const events = []; window.electron.nativeAudio.onEvent(event => { events.push(event); if (events.length > 1000) events.shift(); });
    const mediaLoads = [], browserResumes = [];
    document.addEventListener('loadstart', event => {
      if (event.target instanceof HTMLMediaElement) mediaLoads.push({ sourceTag: sourceTag(event.target.getAttribute('src')), at: performance.now() });
    }, true);
    document.addEventListener('playing', event => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      const url = event.target.getAttribute('src');
      browserResumes.push({ sourceTag: sourceTag(url), currentSource: url === player.getState().audioSrc,
        position: event.target.currentTime, backend: settings.getState().nativeAudioBackend });
    }, true);
    window.outputRegression = { player, settings, hqp, clock, events, search, view, qualityRequests, getAudioSourceMetadata, sourceTag,
      caseCursor: 0, currentQuality: null, mediaLoads, loadCursor: 0, browserResumes, readOutputHandoffDiagnostics };
    await window.electron.nativeAudio.request({ action: 'component-install' });
    await window.electron.nativeAudio.request({ action: 'hqplayer-component-install' });
    await window.electron.nativeAudio.request({ action: 'hqplayer-shutdown' });
  });
  if (process.env.FOLIA_TEST_MEDIA_TRACE === '1') await page.evaluate(() => {
    const q = window.outputRegression; q.mediaTrace = [];
    const record = (media, type, outcome) => {
      q.mediaTrace.push({ at: performance.now(), type, outcome, backend: q.settings.getState().nativeAudioBackend,
        intent: q.player.getState().playerState, currentSource: media.getAttribute('src') === q.player.getState().audioSrc,
        position: media.currentTime, paused: media.paused, readyState: media.readyState, errorCode: media.error?.code });
      if (q.mediaTrace.length > 300) q.mediaTrace.shift();
    };
    for (const type of ['loadstart', 'loadedmetadata', 'seeked', 'play', 'playing', 'pause', 'error'])
      document.addEventListener(type, event => { if (event.target instanceof HTMLMediaElement) record(event.target, type); }, true);
    for (const method of ['play', 'pause', 'load']) {
      const original = HTMLMediaElement.prototype[method];
      HTMLMediaElement.prototype[method] = function (...args) {
        record(this, `call:${method}`);
        const returned = original.apply(this, args);
        return returned?.then ? returned.then(value => { record(this, `result:${method}`, 'resolved'); return value; },
          error => { record(this, `result:${method}`, error.name || 'rejected'); throw error; }) : returned;
      };
    }
  });
  report.devices = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'devices' }));
  const selected = ['wasapi-exclusive', 'asio'].map(backend => report.devices.find(device => device.backend === backend && device.name.includes('XingCore')));
  if (selected.some(device => !device)) throw new Error('XingCore WASAPI/ASIO device missing');
  const referenceTracks = new Map();
  for (const [provider, query, quality] of authenticatedCases) {
    const result = { provider, query, quality, stages: [] }; report.results.push(result);
    const caseStartedAt = await page.evaluate(() => performance.now());
    try {
      result.loginBefore = await checkLogin(provider);
      if (!result.loginBefore.authenticated) { result.outcome = 'blocked-login'; throw new Error('Login is required before this quality case'); }
      const reuseSearch = referenceTracks.has(provider);
      console.log(JSON.stringify({ provider, phase: reuseSearch ? 'reuse-search-results' : 'search' }));
      // Return through the app's own history navigation before interacting with the home search.
      await page.evaluate(() => document.activeElement?.blur());
      for (let navigation = 0; navigation < 6; navigation++) {
        const view = await page.evaluate(() => {
          const state = window.outputRegression.view.getState(); return { view: state.view, panel: state.isPanelOpen };
        });
        if (view.view === 'home' && !view.panel) break;
        await page.keyboard.press('Escape'); await page.waitForTimeout(350);
      }
      await page.waitForFunction(() => {
        const state = window.outputRegression.view.getState(); return state.view === 'home' && !state.isPanelOpen;
      }, null, { timeout: 5000 });
      await page.evaluate(async ({ provider, quality, query, reuseSearch }) => {
        const q = window.outputRegression;
        q.caseCursor = q.qualityRequests.length; q.currentQuality = quality; q.loadCursor = q.mediaLoads.length;
        q.player.getState().setPlayerState('PAUSED');
        await q.settings.getState().handleSetNativeAudioOutput('browser', '');
        const { useOnlineProviderAccountStore } = await import('/src/stores/useOnlineProviderAccountStore.ts');
        useOnlineProviderAccountStore.getState().setActiveProviderId(provider);
        if (reuseSearch) q.search.getState().restoreSearch({ query, sourceTab: provider, returnView: 'home' });
        else q.search.getState().resetRuntime(provider);
        q.settings.getState().setAudioQuality(quality);
      }, { provider, quality, query, reuseSearch });
      await page.waitForFunction(provider => window.outputRegression.search.getState().searchSourceTab === provider, provider);
      if (!reuseSearch) await submitHomeSearch(page, provider, query, 'outputRegression');
      await page.waitForFunction(({ provider, query }) => {
        const s = window.outputRegression.search.getState();
        return !s.isSearching && Array.isArray(s.searchResults) && s.isSearchOpen
          && s.searchSourceTab === provider && s.searchQuery === query;
      }, { provider, query }, { timeout: 45000 });
      result.search = await page.evaluate(() => { const s = window.outputRegression.search.getState(); return { error: s.searchError, count: s.searchResults?.length }; });
      result.search.reusedUiResults = reuseSearch;
      if (result.search.error) { result.outcome = 'provider-search-failed'; throw new Error(result.search.error); }
      if (!result.search.count) throw new Error('Provider search returned no results');
      let trackIndex = 0;
      const referenceId = process.env.FOLIA_TEST_TRACK_ID || referenceTracks.get(provider) || (provider === 'qq' ? '1531817' : undefined);
      if (referenceId) {
        const identities = await page.evaluate(() => window.outputRegression.search.getState().searchResults
          .map(song => ({ id: song.id, sourceRef: { providerId: song.sourceRef?.providerId, mediaId: song.sourceRef?.mediaId } })));
        trackIndex = findQualityReferenceIndex(identities, provider, referenceId);
        if (trackIndex < 0) throw new Error('Requested quality reference track absent from current provider search');
      } else if (provider === 'qq') {
        const candidate = await page.evaluate(async quality => {
          const { omni } = await import('/src/services/onlineMusic/omni.ts');
          const songs = window.outputRegression.search.getState().searchResults;
          const attempts = [];
          for (let index = 0; index < Math.min(songs.length, 8); index++) {
            try {
              const source = await omni.getAudioSource(songs[index], quality);
              attempts.push({ id: songs[index].id, hasMediaMid: Boolean(songs[index].sourceRef?.providerData?.mediaMid), available: Boolean(source?.url) });
              if (source?.url) return { index, attempts };
            } catch (error) { attempts.push({ id: songs[index].id, error: String(error.message).slice(0, 100) }); }
          }
          return { index: -1, attempts };
        }, quality);
        result.candidates = candidate.attempts; trackIndex = candidate.index;
        if (trackIndex < 0) throw new Error('QQ returned no playable source for the first eight results with the verified account');
      }
      const selectedId = await page.evaluate(index => window.outputRegression.search.getState().searchResults[index].id, trackIndex);
      const selectedMediaId = await page.evaluate(index => {
        const song = window.outputRegression.search.getState().searchResults[index];
        return String(song.sourceRef?.mediaId ?? song.id);
      }, trackIndex);
      if (referenceTracks.has(provider) && referenceTracks.get(provider) !== selectedMediaId)
        throw new Error('Quality ladder changed the provider media identity');
      referenceTracks.set(provider, selectedMediaId); result.referenceMediaId = selectedMediaId;
      await page.evaluate(() => { window.outputRegression.loadCursor = window.outputRegression.mediaLoads.length; });
      await page.getByRole('button', { name: 'Play track', exact: true }).nth(trackIndex).click({ timeout: 45000 });
      await page.waitForFunction(({ provider, selectedId }) => {
        const q = window.outputRegression;
        const state = q.player.getState();
        return state.currentSong?.id === selectedId && state.currentSong?.sourceRef?.providerId === provider && state.playerState === 'PLAYING'
          && q.mediaLoads.slice(q.loadCursor).some(load => load.sourceTag === q.sourceTag(state.audioSrc))
          && [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === state.audioSrc && !audio.paused && audio.currentTime > 1);
      }, { provider, selectedId }, { timeout: 90000 });
      if (process.env.FOLIA_TEST_MATRIX_KIND === 'quality') {
        result.browserSourceEvidence = await inspectCurrentBrowserSource(page);
        result.qualityOutcome = assertEncodedQuality(provider, quality, result.browserSourceEvidence.metadata, result.browserSourceEvidence.header);
        result.browserSourceMetadata = result.browserSourceEvidence.metadata;
      }
      result.stages.push({ mode: 'browser', pass: true, ...(matrixKind === 'paused-seek' ? { preparationOnly: true } : {}), state: await snapshot() });
      if (process.env.FOLIA_TEST_FORCE_REMOTE === '1') {
        result.forcedSource = await page.evaluate(async quality => {
          const q = window.outputRegression;
          const { omni } = await import('/src/services/onlineMusic/omni.ts');
          const source = await omni.getAudioSource(q.player.getState().currentSong, quality);
          if (!source?.url) throw new Error('Cold remote source unavailable');
          const changed = source.url !== q.player.getState().audioSrc;
          q.forcedLoadCursor = q.mediaLoads.length;
          q.player.getState().setAudioSrc(source.url);
          return { changed, sourceTag: q.sourceTag(source.url) };
        }, quality);
        await page.waitForFunction(changed => {
          const q = window.outputRegression, url = q.player.getState().audioSrc;
          return [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === url && audio.readyState >= 2)
            && (!changed || q.mediaLoads.slice(q.forcedLoadCursor).some(load => load.sourceTag === q.sourceTag(url)));
        }, result.forcedSource.changed);
        // This is explicit preparation of an additional remote source, before any output
        // handoff. Replacing a signed QQ URL is not a user Play action in the product.
        result.forcedSource.started = await page.evaluate(async () => {
          const q = window.outputRegression;
          const audio = [...document.querySelectorAll('audio')].find(item => item.getAttribute('src') === q.player.getState().audioSrc);
          if (!audio) throw new Error('Forced source has no current browser deck');
          if (!audio.paused) return false;
          await audio.play(); return true;
        });
        await page.waitForFunction(() => {
          const q = window.outputRegression;
          return [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === q.player.getState().audioSrc && !audio.paused && audio.currentTime > 1);
        });
        if (process.env.FOLIA_TEST_MATRIX_KIND === 'quality') {
          result.nativeInputEvidence = await inspectCurrentBrowserSource(page);
          assertEncodedQuality(provider, quality, result.nativeInputEvidence.metadata, result.nativeInputEvidence.header);
          if (!result.nativeInputEvidence.request || result.nativeInputEvidence.header.prefixSha256 !== result.browserSourceEvidence.header.prefixSha256)
            throw new Error('Forced remote input differs from the source actually played by the browser');
        }
        result.forcedSource.newLoadObserved = await page.evaluate(() => {
          const q = window.outputRegression;
          return q.mediaLoads.slice(q.forcedLoadCursor).some(load => load.sourceTag === q.sourceTag(q.player.getState().audioSrc));
        });
        result.stages.push({ mode: 'forced-source-start', pass: true, preparationOnly: true, ...result.forcedSource, state: await snapshot() });
      }
      await page.evaluate(onlyPausedSeek => {
        const q = window.outputRegression, audio = [...document.querySelectorAll('audio')].find(audio => audio.getAttribute('src') === q.player.getState().audioSrc && !audio.paused);
        // Keep this prerequisite checkpoint away from the 20s pointer target so
        // clicking the current native range thumb cannot yield a no-op input.
        q.seekTarget = Math.min(onlyPausedSeek ? 40 : 20, audio.duration / 3); audio.currentTime = q.seekTarget;
      }, matrixKind === 'paused-seek');
      await page.waitForFunction(() => {
        const q = window.outputRegression, audio = [...document.querySelectorAll('audio')].find(audio => audio.getAttribute('src') === q.player.getState().audioSrc && !audio.paused);
        return audio && !audio.seeking && audio.currentTime >= q.seekTarget && Math.abs(q.clock.get() - audio.currentTime) < .5;
      });
      const modes = matrixKind === 'paused-seek' ? [] : process.env.FOLIA_TEST_MATRIX_KIND === 'quality'
        ? [...selected, { backend: 'hqplayer', id: 'hqplayer-local', silent: true }, { backend: 'browser', id: '' }]
        : [...selected, { backend: 'hqplayer', id: 'hqplayer-local', silent: true },
          { backend: 'browser', id: '' }, { backend: 'hqplayer', id: 'hqplayer-local', silent: false }, { backend: 'browser', id: '' }];
      for (const mode of modes) {
        const stageStartedAt = await page.evaluate(() => performance.now());
        const before = await snapshot(), started = Date.now();
        const association = await page.evaluate(() => {
          const q = window.outputRegression, state = q.player.getState(), song = state.currentSong;
          const identity = { provider: song.sourceRef?.providerId, mediaId: String(song.sourceRef?.mediaId ?? song.id),
            sourceTag: q.sourceTag(state.audioSrc), requested: q.currentQuality, caseCursor: q.caseCursor, stageCursor: q.qualityRequests.length };
          return { ...identity, request: q.qualityRequests.slice(q.caseCursor).filter(item => item.available
            && item.provider === identity.provider && item.mediaId === identity.mediaId && item.requested === identity.requested
            && item.sourceTag === identity.sourceTag).at(-1) };
        });
        await page.evaluate(async mode => {
          const q = window.outputRegression; q.events.length = 0; q.browserResumes.length = 0;
          if (mode.backend === 'hqplayer') q.hqp.getState().setSilentLaunch(mode.silent);
          await q.settings.getState().handleSetNativeAudioOutput(mode.backend, mode.id);
        }, mode);
        await page.waitForFunction(({ mode, position }) => {
          const q = window.outputRegression;
          if (q.player.getState().playerState !== 'PLAYING' || q.clock.get() <= position + 1) return false;
          if (mode.backend === 'browser') return [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === q.player.getState().audioSrc && !audio.paused && audio.currentTime > position + 1);
          return q.events.some(event => event.state?.backend === mode.backend && event.state.playing && event.state.position > position + 1);
        }, { mode, position: before.position }, { timeout: mode.backend === 'browser'
          ? Number(process.env.FOLIA_TEST_BROWSER_RETURN_TIMEOUT || 75000) : 75000 });
        const after = await snapshot();
        const rendererErrors = nativeRendererErrors(after.handoff, stageStartedAt);
        if (rendererErrors.length) result.rendererErrors = rendererErrors;
        assertNoNativeRendererErrors(rendererErrors);
        if (process.env.FOLIA_TEST_FORCE_REMOTE === '1' && ['asio', 'wasapi-exclusive'].includes(mode.backend)
          && after.native?.streaming !== true) throw new Error('Expected actual streaming helper state');
        if (after.id !== before.id || after.errors.length) throw new Error('Track changed or native error during output handoff');
        if (process.env.FOLIA_TEST_MATRIX_KIND === 'quality' && mode.backend !== 'browser') {
          const evidence = result.nativeInputEvidence || result.browserSourceEvidence;
          if (association.sourceTag !== evidence.sourceTag || (association.request && association.request.returned !== evidence.metadata.quality))
            throw new Error('Native stage is not associated with this case and loaded source');
          assertNativeSourceFacts(after.native, evidence, mode.backend, quality);
        }
        if (mode.backend !== 'browser') {
          const first = await page.evaluate(({ backend, session }) => window.outputRegression.events
            .find(event => event.state?.playing && event.state.backend === backend && event.state.session === session)?.state?.position,
          { backend: mode.backend, session: after.native?.session });
          if (!Number.isFinite(first) || first < before.position - 1) throw new Error(`Playback restarted instead of resuming: ${first} < ${before.position}`);
        } else {
          const first = await page.evaluate(tag => window.outputRegression.browserResumes.find(event => event.backend === 'browser'
            && event.currentSource && event.sourceTag === tag)?.position, association.sourceTag);
          if (!Number.isFinite(first) || first < before.position - 1) throw new Error(`Browser restarted instead of resuming: ${first} < ${before.position}`);
        }
        const stage = { mode, pass: true, association, before, after, elapsedMs: Date.now() - started }; result.stages.push(stage);
        if (mode.backend === 'hqplayer') {
          stage.windows = hqplayerWindowState();
          assertHQPlayerWindowVisibility(stage.windows, mode.silent);
          if (!mode.silent) result.stages.push(await applyCurrentDsp(page, snapshot));
        } else if (before.backend === 'hqplayer') {
          stage.windows = hqplayerWindowState();
          if (stage.windows.pids.length) throw new Error('HQPlayer did not exit on output switch');
        }
        console.log(JSON.stringify({ provider, mode, position: after.position, pass: true }));
      }
      if (matrixKind !== 'quality') {
        const lifecycleStages = [];
        const options = { stages: lifecycleStages, ...(matrixKind === 'paused-seek' ? { rapid: false,
          modes: [...selected, { backend: 'hqplayer', id: 'hqplayer-local', silent: true }, { backend: 'browser', id: '' }]
            .filter(mode => pausedBackends.includes(mode.backend)) } : {}) };
        try { await checkOutputLifecycle(page, selected, snapshot, hqplayerWindowState, options); }
        finally { result.stages.push(...lifecycleStages); }
      }
      result.rendererErrors = nativeRendererErrors((await snapshot()).handoff, caseStartedAt);
      assertNoNativeRendererErrors(result.rendererErrors);
      result.loginAfter = await checkLogin(provider);
      if (!result.loginAfter.authenticated) { result.outcome = 'blocked-login'; throw new Error('Login could not be verified after playback; acceptance result invalidated'); }
      result.pass = true; result.outcome = 'passed';
    } catch (error) {
      result.pass = false; result.error = String(error.message).slice(0, 500);
      result.rendererErrors = nativeRendererErrors((await snapshot()).handoff, caseStartedAt);
      result.loginAfter ??= await checkLogin(provider).catch(() => ({ authenticated: false }));
      if (!result.loginAfter.authenticated) result.outcome = 'blocked-login';
      result.searchAfterFailure = await page.evaluate(() => {
        const s = window.outputRegression.search.getState();
        return { query: s.searchQuery, provider: s.searchSourceTab, searching: s.isSearching,
          error: s.searchError, count: s.searchResults?.length };
      }).catch(() => null);
      result.last = await snapshot().catch(() => null); console.log(JSON.stringify(result));
      result.progressControlObservation = await page.evaluate(() => window.outputRegression.progressSelection).catch(() => null);
    } finally {
      result.qualityRequests = await page.evaluate(provider => {
        const q = window.outputRegression;
        return q.qualityRequests.slice(q.caseCursor).filter(item => item.provider === provider);
      }, provider).catch(() => []);
    }
    if (process.env.FOLIA_TEST_STOP_ON_FAILURE === '1' && !result.pass) break;
  }
} catch (error) { report.error = String(error.message).slice(0, 500); }
finally {
  if (page && report.runtimeIdentity) {
    try {
      report.runtimeIdentityAfter = await assertColdFoliaModuleGraph(page);
      if (!report.runtimeIdentityAfter.completeResourceObservation) throw new Error('Fresh Folia module graph observation is missing');
    } catch { report.error ||= 'Folia module identity became unverified during playback acceptance'; report.moduleIdentityInvalidated = true; }
  }
  if (page) await page.evaluate(async () => { if (!window.outputRegression) return; window.outputRegression.player.getState().setPlayerState('PAUSED'); await window.electron.nativeAudio.request({ action: 'hqplayer-shutdown' }); }).catch(() => {});
  await application.close();
  await Promise.allSettled([...qqNetworkPending]);
  report.finishedAt = new Date().toISOString(); await mkdir(directory, { recursive: true });
  const file = path.join(directory, `app-output-regression-${Date.now()}.json`); await writeFile(file, JSON.stringify(report, null, 2));
  console.log(file); process.exitCode = !report.error && report.results.length === cases.length && report.results.every(result => result.pass) ? 0 : 1;
}
