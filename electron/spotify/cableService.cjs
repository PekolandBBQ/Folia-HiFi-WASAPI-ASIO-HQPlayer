'use strict';
const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');
const path = require('node:path');
const { createSessionVault } = require('./sessionVault.cjs');
const { createSpotifyCatalog } = require('./catalog.cjs');
const { createOfficialTrackMetadata } = require('./officialTrackMetadata.cjs');
const { createCatalogLogin, NCSPOT_CLIENT_ID } = require('./catalogLogin.cjs');
const { createLoginCoordinator } = require('./loginCoordinator.cjs');
const { createCooldown } = require('./cooldown.cjs');
const { createSpotifyRuntime } = require('./runtime.cjs');
const { createSoloistBrowserSession } = require('./soloistBrowserSession.cjs');
const { createCableSetup } = require('./cableSetup.cjs');
const { reportCableCapture, reportCableHelper, reportOwnedRoute } = require('./cableDiagnostics.cjs');
const { spotifyError } = require('./errors.cjs');
const { observeSpotifyOperation, observeSpotifyService } = require('./privatePreviewObserver.cjs');
const { createOwnedRouteHost } = require('./ownedRouteHost.cjs');
const { createOwnedRouteLifecycle } = require('./ownedRouteLifecycle.cjs');
const { nativeComponentPath } = require('./nativeComponentPath.cjs');

// Windows desktop capture keeps catalog grants in their existing directory and never starts the archived VM.
const ACTIONS = new Set(['loginBegin', 'loginImage', 'loginCheck', 'loginCancel', 'status', 'logout', 'search', 'playlists',
  'savedTracks', 'song', 'playlist', 'playlistTracks', 'album', 'albumTracks', 'audio', 'cancelAudio', 'leaveProvider', 'playbackSetup']);
function createCableSpotifyService({ directory, safeStorage, fetcher, renderQr, diagnostic, openAuthorization,
  catalogClientId = NCSPOT_CLIENT_ID, catalogRedirectUri, helperPath, driverDirectory, openPath, platform = process.platform,
  createCaptureHost, createControl, createAudio, createSetup = createCableSetup, onRevoke = () => {}, beforeLeaveProvider = async () => {},
  routeComponentDirectory = nativeComponentPath('spotify-route'), createRouteHost = createOwnedRouteHost,
  createRouteLifecycle = createOwnedRouteLifecycle }) {
  if (!/^[a-f0-9]{32}$/.test(catalogClientId)) throw spotifyError('invalid-response', 'invalid-client-id');
  const catalogDirectory = path.join(directory, 'web-api', catalogClientId);
  const vault = createSessionVault({ directory: catalogDirectory, safeStorage, fetcher, diagnosticScopes: true });
  const officialMetadata = createOfficialTrackMetadata({ getStamp: () => vault.stamp() });
  const cooldown = createCooldown({ directory: catalogDirectory });
  const catalog = createSpotifyCatalog({ vault, fetcher, directory: catalogDirectory, diagnostic, cooldown, officialMetadata });
  const catalogLogin = createCatalogLogin({ vault, clientId: catalogClientId, redirectUri: catalogRedirectUri, fetcher, renderQr, openAuthorization });
  const captureHost = (createCaptureHost || require('./cableCaptureHost.cjs').createCableCaptureHost)({ helperPath, platform,
    onDiagnostic: reportCableCapture, onControlDiagnostic: reportCableHelper });
  let audio, control;
  const routeHost = createRouteHost({ componentDirectory: routeComponentDirectory, platform,
    onSourceControl: (input, options) => control.routeSourceControl(input, options) });
  const routeLifecycle = createRouteLifecycle({ host: routeHost, onDiagnostic: reportOwnedRoute });
  control = (createControl || require('./desktopPlaybackControl.cjs').createDesktopPlaybackControl)({ vault, cooldown, fetcher,
    coldBootstrapDirectory: catalogDirectory,
    readRoutePcmEvidence: (session, generation) => routeLifecycle.pcmStopped(session, generation),
    readSeekParkEvidence: (session, generation, transaction, token) => routeLifecycle.seekParkEvidence(session, generation, transaction, token),
    onRevoke: value => { audio?.revokeSession(value.session, value.code); } });
  const setup = createSetup({ directory, captureHost, control, routeLifecycle, platform, driverDirectory, openPath, openExternal: openAuthorization,
    revokePlayback: async options => { officialMetadata.clear(); onRevoke({ code: 'SETUP_CHANGED' }); await browser.clear(); await audio.invalidate('SETUP_CHANGED', options); } });
  audio = (createAudio || require('./cableAudioPreparation.cjs').createCableAudioPreparation)({ captureHost, control, vault, cooldown, routeLifecycle,
    fetcher, getSelection: options => setup.getSelection(options),
    ...(typeof setup.prefetchSelection === 'function' ? { prefetchSelection: options => setup.prefetchSelection(options) } : {}), onDiagnostic: reportCableCapture, officialMetadata });
  const browser = createSoloistBrowserSession({ lookup: url => audio.lookup(url) });
  const unusedDevice = { clear() {}, cancel() {} };
  const login = createLoginCoordinator({ device: unusedDevice, catalog: catalogLogin, vault, deviceRequired: false,
    onBegin: async () => { setup.clear(); catalog.clear(); await browser.clear(); await audio.invalidate('SESSION_CHANGED'); } });
  let closed = false, closing, shutdownCommitted = false, outputCleanupFailure;
  async function outputCleanup(operation) {
    try { const receipt = await operation(); outputCleanupFailure = undefined; return receipt; }
    catch (cause) {
      // Keep the exact output failure retryable without claiming a native route receipt.
      outputCleanupFailure = Object.assign(new Error('Spotify: source-output-release-unconfirmed'),
        { code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED', cause });
      throw outputCleanupFailure;
    }
  }
  const releaseOutputBeforeProviderExit = () => outputCleanup(beforeLeaveProvider);
  const completeProviderOutput = output => outputCleanup(() => output?.complete?.());
  return observeSpotifyService({
    async request(input, onProgress, diagnosticContext) {
      if (closed) throw spotifyError('unavailable', 'runtime-closed');
      if (!input || !ACTIONS.has(input.action)) throw spotifyError('unsupported');
      if (input.action === 'playbackSetup') return setup.request(input);
      if (input.action === 'loginBegin') return login.begin();
      if (['loginImage', 'loginCheck', 'loginCancel'].includes(input.action)) {
        if (typeof input.key !== 'string' || input.key.length > 80) throw spotifyError('invalid-response', 'invalid-login-key');
        if (input.action === 'loginImage') return login.image(input.key);
        if (input.action === 'loginCheck') return login.check(input.key);
        login.cancel(input.key); return null;
      }
      if (input.action === 'logout') {
        login.clear(); setup.clear(); catalog.clear(); onRevoke({ code: 'LOGOUT' });
        await browser.clear(); await audio.invalidate('AUTH_REQUIRED'); await vault.clear(); return null;
      }
      if (input.action === 'leaveProvider') {
        const output = await releaseOutputBeforeProviderExit(); await browser.clear();
        await audio.leaveProvider('provider-exit'); await completeProviderOutput(output); return null;
      }
      if (input.action === 'cancelAudio') { audio.cancel(input.requestId); return null; }
      if (input.action === 'audio') return audio.prepare(input.id, input.requestId, onProgress, input.quality);
      return catalog.request(input.action, input, diagnosticContext);
    },
    async invalidatePlayback(reason = 'SESSION_CHANGED') {
      officialMetadata.clear(); setup.clear(); catalog.clear();
      await browser.clear(); await audio.invalidate(reason);
    },
    async prepareSourceOutput(url, backend) {
      if (closed) throw spotifyError('unavailable', 'runtime-closed');
      let identity = url, localhostAlias = false;
      if (typeof url === 'string' && /^https?:/i.test(url)) {
        const parsed = new URL(url); parsed.hash = '';
        localhostAlias = ['localhost', 'localhost.'].includes(parsed.hostname);
        if (localhostAlias) parsed.hostname = '127.0.0.1';
        identity = parsed.href;
      }
      if (identity && audio.isSourceUrl(identity)) {
        if (localhostAlias) throw spotifyError('invalid-response', 'invalid-browser-source');
        if (!audio.lookup(identity)) throw spotifyError('unavailable', 'request-cancelled');
        return;
      }
      const output = await releaseOutputBeforeProviderExit();
      await browser.clear();
      await audio.leaveProvider('provider-exit');
      await completeProviderOutput(output);
    },
    readCatalogGrantedScopes() { return vault.grantedScopes(); },
    // The alias preserves existing native-output registration; its source can now be desktop capture.
    lookupSoloistPcmSource(url) { return closed ? null : audio.lookup(url); },
    requestBrowserPcm(input) { if (closed) throw spotifyError('unavailable', 'runtime-closed'); return browser.request(input); },
    canRetryClose(error) { return error === outputCleanupFailure || isRetryableRouteCleanup(error); },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // Convert synchronous disposal throws as well as rejections into settled results.
        const settle = tasks => Promise.allSettled(tasks.map(invoke => Promise.resolve().then(invoke)));
        const output = await releaseOutputBeforeProviderExit();
        const results = await settle([() => login.clear(), () => setup.clear(), () => catalog.clear(),
          () => browser.clear(), () => audio.clear()]);
        const retryable = results.find(item => item.status === 'rejected' && isRetryableRouteCleanup(item.reason));
        if (retryable) throw retryable.reason;
        try { await routeLifecycle.releaseBeforeClose(); }
        catch (error) { if (isRetryableRouteCleanup(error)) throw error; }
        // After irreversible capture shutdown, retry Quit without advertising a
        // reusable service. Recovery before this point leaves capture available.
        shutdownCommitted = true;
        const captureResult = (await settle([() => captureHost.close()]))[0]; results.push(captureResult);
        if (captureResult.status === 'fulfilled') {
          routeLifecycle.captureHelperExited();
          // Capture exit must settle before the last owned route compensation and helper shutdown.
          const routeResult = (await settle([() => routeLifecycle.close()]))[0]; results.push(routeResult);
          // Preserve the narrow proof broker if native cleanup remains unresolved.
          if (routeResult.status === 'fulfilled') {
            const final = await settle([() => audio.close(), () => browser.close(), () => setup.close(), () => control.dispose()]);
            if (final.every(item => item.status === 'fulfilled')) {
              for (let index = results.length - 1; index >= 0; index--)
                if (results[index].status === 'rejected' && results[index].reason?.code === 'ROUTE_RESTORE_UNCONFIRMED') results.splice(index, 1);
            }
            results.push(...final);
            if (final.every(item => item.status === 'fulfilled')) await completeProviderOutput(output);
          }
        }
        // An unrelated disposal failure must not hide an unconfirmed owned helper.
        const failed = results.find(item => item.status === 'rejected' && ['ROUTE_RESTORE_UNCONFIRMED', 'ROUTE_HELPER_EXIT_UNCONFIRMED', 'ROUTE_SOURCE_PAUSE_UNCONFIRMED'].includes(item.reason?.code))
          || results.find(item => item.status === 'rejected' && item.reason?.code === 'CAPTURE_HELPER_EXIT_UNCONFIRMED')
          || results.find(item => item.status === 'rejected');
        if (failed) throw failed.reason;
        vault.dispose(); officialMetadata.dispose();
      })();
      void closing.catch(error => { if (error === outputCleanupFailure || isRetryableRouteCleanup(error)) { closing = null; closed = shutdownCommitted; } });
      return closing;
    },
  });
}
function registerCableSpotify({ app, ipcMain, isTrustedSender, createService = createCableSpotifyService,
  connectionMode = 'oauth', platform = process.platform, beforeLeaveProvider = async () => {}, electron = require('electron') }) {
  let runtime, closing = false, quitAllowed = false, epoch = 0, sourceRevision = 0, mutations = Promise.resolve();
  const { safeStorage, net, shell } = electron;
  const directory = process.env.FOLIA_SPOTIFY_PREVIEW === '1' && process.env.FOLIA_SPOTIFY_PREVIEW_DIRECTORY
    ? path.resolve(process.env.FOLIA_SPOTIFY_PREVIEW_DIRECTORY) : path.join(app.getPath('userData'), 'spotify');
  const componentDirectory = nativeComponentPath('spotify-cable');
  function acquire() {
    if (runtime) return runtime;
    runtime = createSpotifyRuntime({ directory, connectionMode, createService: settings => createService({ directory, safeStorage, ...settings,
      platform, beforeLeaveProvider, helperPath: path.join(componentDirectory, 'folia-capture.exe'), driverDirectory: path.join(componentDirectory, 'vendor'),
      openAuthorization: url => shell.openExternal(url), openPath: file => shell.openPath(file),
      onRevoke: () => app.emit('session-bound-audio-revoked', { providerId: 'spotify' }),
      fetcher: (url, options) => net.fetch(url, options), renderQr: url => require('qrcode').toDataURL(url, { width: 256, margin: 2 }) }) });
    return runtime;
  }
  async function barrier() {
    for (;;) { const pending = mutations; await pending; if (closing) throw spotifyError('unavailable', 'runtime-closed'); if (pending === mutations) return; }
  }
  function mutate(operation) {
    const task = mutations.then(async () => { if (closing) throw spotifyError('unavailable', 'runtime-closed'); epoch++; return operation(); });
    mutations = task.catch(() => {}); return task;
  }
  const publicFailure = (error, operation) => {
    const details = require('./failureDetails.cjs').failureDetails(error, operation);
    try {
      const logs = path.join(directory, 'diagnostics'); require('node:fs').mkdirSync(logs, { recursive: true });
      require('node:fs').appendFileSync(path.join(logs, new Date().toISOString().slice(0,10) + '.jsonl'), JSON.stringify({ at: Date.now(), operation, ...details }) + '\n');
    } catch { /* Logging never blocks recovery. */ }
    return { spotifyError: {
    ...require('./failureDetails.cjs').failureDetails(error, operation), code: spotifyError(error?.code || 'unavailable').code,
    ...(error?.code === 'DESKTOP_SOURCE_UNQUALIFIED' ? { sourceCode: 'DESKTOP_SOURCE_UNQUALIFIED' } : {}),
    message: /^ROUTE_/.test(error?.code || '') ? 'Spotify: automatic-route-restore-unconfirmed' : /^Spotify: [a-z0-9-]+$/.test(error?.message || '') ? error.message : 'Spotify: cable-operation-failed' } }; };
  ipcMain.handle('spotify:request', async (event, input) => {
    if (closing || !isTrustedSender(event.sender)) return publicFailure(spotifyError('unavailable', 'untrusted-sender'));
    try {
      return await observeSpotifyOperation('ipc', input, async () => {
        if (input?.action === 'sourceRevision') { await barrier(); return { revision: sourceRevision, ownsRoute: true }; }
        if (input?.action === 'leaveProvider') {
          if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0)
            throw spotifyError('invalid-response', 'invalid-source-revision');
          return mutate(async () => {
            if (input.expectedSourceRevision !== sourceRevision) throw spotifyError('unavailable', 'request-cancelled');
            return runtime?.leaveProvider();
          });
        }
        const perform = () => {
          if (input?.action === 'audio') sourceRevision++;
          return acquire().request(input, progress => {
          if (!event.sender.isDestroyed()) event.sender.send('spotify:progress', { requestId: input.requestId, ...progress });
          });
        };
        if (['logout', 'configure', 'loginBegin'].includes(input?.action)
            || input?.action === 'playbackSetup' && ['saveSelection', 'stop'].includes(input.operation)) {
          app.emit('session-bound-audio-revoked', { providerId: 'spotify' }); return mutate(perform);
        }
        await barrier(); const expected = epoch, value = await perform();
        if (closing || expected !== epoch) throw spotifyError('unavailable', 'request-cancelled'); return value;
      });
    } catch (error) { if (input?.action === 'audio' || !input?.action) require('./playbackHealth.cjs').failed(error, input?.action || 'browser-pcm'); return publicFailure(error, input?.action || 'browser-pcm'); }
  });
  ipcMain.handle('spotify:browser-pcm', async (event, input) => {
    if (closing || !runtime || !isTrustedSender(event.sender)) return publicFailure(spotifyError('unavailable', 'untrusted-sender'));
    try {
      await barrier(); const expected = epoch, value = await runtime.requestBrowserPcm(input);
      if (closing || expected !== epoch) throw spotifyError('unavailable', 'request-cancelled'); return value;
    } catch (error) { require('./playbackHealth.cjs').failed(error, 'browser-pcm'); return publicFailure(error, 'browser-pcm'); }
  });
  app.on('before-quit', event => {
    if (quitAllowed || !runtime && !closing) return;
    event.preventDefault(); if (closing) return;
    closing = true; epoch++;
    void mutations.then(() => runtime?.close()).then(() => { quitAllowed = true; app.quit(); }).catch(error => {
      if (!/^ROUTE_/.test(error?.code || '') && error?.code !== 'CAPTURE_HELPER_EXIT_UNCONFIRMED') {
        quitAllowed = true; app.quit(); return;
      }
      // Keep Folia available to report recovery; an unconfirmed restore never counts as a clean quit.
      closing = false;
      app.emit('spotify-route-cleanup-failed', { code: error?.code === 'ROUTE_HELPER_EXIT_UNCONFIRMED'
        ? 'ROUTE_HELPER_EXIT_UNCONFIRMED' : 'ROUTE_RESTORE_UNCONFIRMED' });
      const failure = publicFailure(error, 'exit-restore').spotifyError;
      void electron.dialog?.showMessageBox({ type: 'error', title: 'Spotify 路由恢复未完成',
        message: failure.detail || '未能确认 Spotify 原输出路由已恢复。',
        detail: isRetryableRouteCleanup(error)
          ? '原路由恢复任务已保留。当前 Spotify 请求结束后，可以再次退出以重试恢复。'
          : '原路由恢复尚未确认，Folia 暂时保留窗口和恢复记录。',
        buttons: ['保留 Folia'], noLink: true }).catch(() => {});
    });
  });
  return {
    prepareSourceOutput(url, backend) {
      if (!runtime && !closing) return Promise.resolve();
      return mutate(() => runtime?.prepareSourceOutput(url, backend));
    },
    lookupSoloistPcmSource(url) { return closing ? null : runtime?.lookupSoloistPcmSource(url) || null; } };
}
module.exports = { createCableSpotifyService, registerCableSpotify };
