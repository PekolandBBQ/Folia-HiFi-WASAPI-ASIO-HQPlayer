const path = require('node:path');
const { createSessionVault } = require('./sessionVault.cjs');
const { createDeviceLogin } = require('./deviceLogin.cjs');
const { createSpotifyCatalog } = require('./catalog.cjs');
const { spotifyError } = require('./errors.cjs');
const { createNativeHost } = require('./nativeHost.cjs');
const { createCatalogLogin, NCSPOT_CLIENT_ID } = require('./catalogLogin.cjs');
const { createLoginCoordinator } = require('./loginCoordinator.cjs');
const { createAudioPreparation } = require('./audioPreparation.cjs');
const { createAccountIdentity } = require('./accountIdentity.cjs');
const { createSpotifyRuntime } = require('./runtime.cjs');
const { createCooldown } = require('./cooldown.cjs');
const { createLiveAssociationCandidate } = require('./liveAssociation.cjs');
const { createSoloistAudioPreparation } = require('./soloistAudioPreparation.cjs');
const { createSoloistBrowserSession } = require('./soloistBrowserSession.cjs');
const { createSoloistRuntime } = require('./soloistRuntime.cjs');
const { observeSpotifyOperation, observeSpotifyService } = require('./privatePreviewObserver.cjs');

// Development integration only. This service owns a fresh account; no legacy token import path.
const CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
const ACTIONS = new Set(['loginBegin', 'loginImage', 'loginCheck', 'loginCancel', 'status', 'logout', 'search', 'playlists', 'savedTracks', 'song', 'playlist', 'playlistTracks', 'album', 'albumTracks', 'audio', 'cancelAudio']);
function createSpotifyService({ directory, safeStorage, fetcher, renderQr, diagnostic, nativeExecutable, openAuthorization,
  catalogClientId = NCSPOT_CLIENT_ID, catalogRedirectUri, ownedSoloist, soloistPcmClient, soloistDeviceName, soloistApplyQuality }) {
  const vault = createSessionVault({ directory, safeStorage, fetcher });
  if (!/^[a-f0-9]{32}$/.test(catalogClientId)) throw spotifyError('invalid-response', 'invalid-client-id');
  const catalogDirectory = path.join(directory, 'web-api', catalogClientId);
  const catalogVault = createSessionVault({ directory: catalogDirectory, safeStorage, fetcher, diagnosticScopes: true });
  const device = createDeviceLogin({ vault, clientId: CLIENT_ID, fetcher, renderQr, openAuthorization });
  const catalogLogin = createCatalogLogin({ vault: catalogVault, clientId: catalogClientId, redirectUri: catalogRedirectUri, fetcher, renderQr, openAuthorization });
  const catalogCooldown = createCooldown({ directory: catalogDirectory });
  const catalog = createSpotifyCatalog({ vault: catalogVault, fetcher, directory: catalogDirectory, diagnostic, cooldown: catalogCooldown });
  // Private main-owned engineering probe. It never replaces the existing account identity gate.
  const association = ownedSoloist ? createLiveAssociationCandidate({ vault: catalogVault, cooldown: catalogCooldown, guest: ownedSoloist, fetcher,
    expectedDeviceName: soloistDeviceName }) : null;
  const native = nativeExecutable ? createNativeHost({ vault, executable: nativeExecutable }) : null;
  const identity = native ? createAccountIdentity({ playbackProfile: () => native.request({ action: 'status' }), catalogProfile: () => catalog.request('status') }) : null;
  const audio = native ? createAudioPreparation({ directory: path.join(directory, 'temporary-audio'), native,
    vault: { token: async () => { await identity.ensure(); return vault.token(); } } }) : null;
  const soloistAudio = soloistPcmClient && association ? createSoloistAudioPreparation({ client: soloistPcmClient,
    vault: catalogVault, cooldown: catalogCooldown, association, fetcher, soloistApplyQuality }) : null;
  const browser = soloistAudio ? createSoloistBrowserSession({ lookup: url => soloistAudio.lookup(url) }) : null;
  const login = createLoginCoordinator({ device, catalog: catalogLogin, vault, deviceRequired: !soloistAudio,
    onBegin: async () => { association?.clear(); identity?.clear(); native?.clear(); catalog.clear(); await browser?.clear(); await Promise.all([audio?.clear(), soloistAudio?.clear()]); } });
  return observeSpotifyService({
    async request(input, onProgress, diagnosticContext) {
      if (!input || !ACTIONS.has(input.action)) throw spotifyError('unsupported');
      if (input.action === 'loginBegin') return login.begin();
      if (['loginImage', 'loginCheck', 'loginCancel'].includes(input.action)) {
        if (typeof input.key !== 'string' || input.key.length > 80) throw spotifyError('invalid-response', 'invalid-login-key');
        if (input.action === 'loginImage') return login.image(input.key);
        if (input.action === 'loginCheck') return login.check(input.key);
        login.cancel(input.key); return null;
      }
      if (input.action === 'logout') { login.clear(); association?.clear(); identity?.clear(); catalog.clear(); native?.clear(); await browser?.clear(); await Promise.all([vault.clear(), catalogVault.clear(), audio?.clear(), soloistAudio?.clear()]); return null; }
      if (input.action === 'cancelAudio') { audio?.cancel(input.requestId); soloistAudio?.cancel(input.requestId); return null; }
      if (input.action === 'audio') {
        if (soloistAudio) return soloistAudio.prepare(input.id, input.requestId, onProgress, input.quality);
        if (!audio) throw spotifyError('unavailable', 'native-unavailable');
        return audio.prepare(input.id, input.requestId, onProgress, input.quality, { streaming: input.streaming === true });
      }
      if (input.action === 'status' && native && !soloistAudio) {
        if (!await vault.token() || !await catalogVault.token()) return null;
        return identity.ensure({ fresh: true });
      }
      if (input.action === 'search' && !soloistAudio) await identity?.ensure();
      if (native && !soloistAudio && !['search', 'savedTracks'].includes(input.action)) return native.request(input);
      return catalog.request(input.action, input, diagnosticContext);
    },
    // Deliberately absent from ACTIONS/IPC. Only the owned runtime constructor can supply a guest adapter.
    readCatalogGrantedScopes() { return catalogVault.grantedScopes(); },
    // Not an ACTIONS/IPC route: native main integration can resolve only our active opaque source.
    lookupSoloistPcmSource(url) { return soloistAudio?.lookup(url) || null; },
    requestBrowserPcm(input) { if (!browser) throw spotifyError('unsupported', 'browser-pcm-unavailable'); return browser.request(input); },
    observeOwnedSoloistAssociation(options) {
      return association ? association.verify(options) : Promise.resolve({ canonicalIdentityVerified: false, accountPlaybackAssociation: 'unverified',
        reason: 'OWNERSHIP_UNKNOWN', restoration: 'not-required', evidence: null });
    },
    async close() { login.clear(); association?.clear(); identity?.clear(); catalog.clear(); native?.clear(); await browser?.close(); await Promise.all([audio?.close(), soloistAudio?.close()]); soloistPcmClient?.dispose(); },
  });
}
function registerSpotify({ app, ipcMain, isTrustedSender, createService = createSpotifyService, soloistConfiguration,
  createSoloist = createSoloistRuntime, applianceComposition, createAppliance, beforeLeaveProvider }) {
  // Windows mainline uses official desktop audio through VB-CABLE. Keep the explicit
  // appliance composition available for the archived Linux/VM work and its tests.
  if (process.platform === 'win32' && createService === createSpotifyService && !soloistConfiguration && !applianceComposition && !createAppliance)
    return require('./cableService.cjs').registerCableSpotify({ app, ipcMain, isTrustedSender, beforeLeaveProvider });
  let service, closing = false, quitAllowed = false, mutation = Promise.resolve(), epoch = 0;
  const appliance = applianceComposition || (!soloistConfiguration
    ? (createAppliance || require('./soloistApplication.cjs').createApplicationSoloist)({ app, safeStorage: require('electron').safeStorage }) : null);
  const configuration = soloistConfiguration || appliance?.getSoloistConfiguration();
  let soloist = createSoloist({ configuration });
  // A stopped appliance gets new ports and SSH trust. Dispose the previous
  // control runtime before reconstructing it; closing preserves account grants.
  function resetPlayback() { return observeSpotifyOperation('lifecycle', null, async () => {
    epoch++;
    app.emit('session-bound-audio-revoked', { providerId: 'spotify' });
    const previous = service, previousSoloist = soloist;
    service = undefined;
    try { await previous?.close(); } finally {
      try { await previousSoloist.close(); } finally { if (!closing) soloist = createSoloist({ configuration }); }
    }
  }, { lifecycle: 'resetPlayback' }); }
  function mutate(operation) {
    const task = mutation.then(() => {
      if (closing) throw spotifyError('unavailable', 'runtime-closed');
      return operation();
    });
    mutation = task.catch(() => {});
    return task;
  }
  // More than one stop/key change can be queued while a caller waits. Observe
  // the newest settled barrier before accessing a service or starting setup.
  async function waitForMutation() {
    for (;;) {
      const pending = mutation;
      await pending;
      if (closing) throw spotifyError('unavailable', 'runtime-closed');
      if (pending === mutation) return;
    }
  }
  async function freshResult(operation) {
    await waitForMutation();
    const requestedEpoch = epoch, result = await operation();
    if (closing || requestedEpoch !== epoch) throw spotifyError('unavailable', 'request-cancelled');
    return result;
  }
  const setup = appliance ? require('./soloistSetupHandler.cjs').createSoloistSetupHandler({ appliance,
    openExternal: url => require('electron').shell.openExternal(url),
    revokePlayback: resetPlayback }) : null;
  function acquireService() {
    if (service) return service;
    const { safeStorage, net, shell } = require('electron');
    const QRCode = require('qrcode');
    const directory = process.env.FOLIA_SPOTIFY_PREVIEW === '1' && process.env.FOLIA_SPOTIFY_PREVIEW_DIRECTORY
      ? path.resolve(process.env.FOLIA_SPOTIFY_PREVIEW_DIRECTORY) : path.join(app.getPath('userData'), 'spotify');
    service = observeSpotifyOperation('lifecycle', null, () => createSpotifyRuntime({ directory, createService: settings => createService({ directory, safeStorage,
      openAuthorization: url => shell.openExternal(url),
      ...settings,
      ...soloist.getServiceOptions(),
      nativeExecutable: process.env.FOLIA_SPOTIFY_PREVIEW === '1' && process.env.FOLIA_SPOTIFY_NATIVE_PATH
        ? path.resolve(process.env.FOLIA_SPOTIFY_NATIVE_PATH) : app.isPackaged ? path.join(process.resourcesPath, 'spotify', 'folia-spotify-playback.exe')
        : path.resolve(__dirname, '../../build/spotify/folia-spotify-playback.exe'),
      fetcher: (url, options) => net.fetch(url, options), renderQr: url => QRCode.toDataURL(url, { width: 256, margin: 2 }) }) }), { lifecycle: 'service-create' });
    return service;
  }
  ipcMain.handle('spotify:request', async (event, input) => {
    if (closing || !isTrustedSender(event.sender)) return { spotifyError: { code: 'unavailable', message: 'Spotify: untrusted-sender' } };
    try {
      return await observeSpotifyOperation('ipc', input, async () => {
        // This archived runtime owns no desktop output policy. Keep ordinary source
        // commits independent of its appliance/catalog initialization.
        if (input?.action === 'sourceRevision') return { ownsRoute: false };
        if (input?.action === 'playbackSetup') {
          if (!setup) throw spotifyError('unavailable', 'playback-setup-unavailable');
          const perform = () => setup(input, progress => { if (!event.sender.isDestroyed()) event.sender.send('spotify:progress', { requestId: input.requestId, ...progress }); });
          return await (['saveKey', 'stop'].includes(input.operation) ? mutate(perform) : freshResult(perform));
        }
        const perform = () => acquireService().request(input, progress => {
          if (!event.sender.isDestroyed()) event.sender.send('spotify:progress', { requestId: input.requestId, ...progress });
        });
        if (input?.action === 'logout') return await mutate(async () => {
          let result, failure;
          try { result = await perform(); } catch (error) { failure = error; }
          try { await resetPlayback(); } catch (error) { failure ||= error; }
          try { await appliance?.logout(); } catch (error) { failure ||= error; }
          if (failure) throw failure;
          return result;
        });
        await waitForMutation();
        if (['loginBegin', 'configure'].includes(input?.action)) app.emit('session-bound-audio-revoked', { providerId: 'spotify' });
        return await freshResult(perform);
      });
    } catch (error) {
      return { spotifyError: { code: spotifyError(error.code || 'network').code, message: /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'Spotify: request-failed' } };
    }
  });
  ipcMain.handle('spotify:browser-pcm', async (event, input) => {
    if (closing || !service || !isTrustedSender(event.sender)) return { spotifyError: { code: 'unavailable', message: 'Spotify: untrusted-sender' } };
    try { return await observeSpotifyOperation('browser-ipc', input,
      () => freshResult(() => { if (!service) throw spotifyError('unavailable', 'runtime-closed'); return service.requestBrowserPcm(input); })); }
    catch (error) { return { spotifyError: { code: spotifyError(error.code || 'network').code,
      message: /^Spotify: [a-z0-9-]+$/.test(error.message) ? error.message : 'Spotify: browser-pcm-failed' } }; }
  });
  app.on('before-quit', event => {
    if (quitAllowed || (!service && !appliance && !closing)) return;
    event.preventDefault();
    if (closing) return;
    closing = true; epoch++;
    void require('../quitCleanup.cjs').settleQuitCleanup(() => observeSpotifyOperation('lifecycle', null,
      () => mutation.finally(() => service?.close()).finally(() => soloist.close()).finally(() => appliance?.close()), { lifecycle: 'shutdown' })
      , error => console.warn('[Spotify] Exit cleanup incomplete', { code: error?.code || 'UNKNOWN' }))
      .then(() => { quitAllowed = true; app.quit(); });
  });
  return { lookupSoloistPcmSource(url) { return closing ? null : service?.lookupSoloistPcmSource(url) || null; } };
}
module.exports = { createSpotifyService, registerSpotify };
