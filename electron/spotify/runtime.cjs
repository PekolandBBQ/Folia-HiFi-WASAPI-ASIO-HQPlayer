const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');
const { readClientSettings, writeClientSettings } = require('./clientSettings.cjs');
const { spotifyError } = require('./errors.cjs');
const { NCSPOT_CLIENT_ID } = require('./catalogLogin.cjs');

// Serializes client changes against new requests while cancelling work from the previous configuration.
function createSpotifyRuntime({ directory, createService, environment = process.env, connectionMode = 'oauth' }) {
  let service, queue = Promise.resolve(), closed = false, cleanupFailed = false, cleanupFailure, closing, reconfigurePending = false;
  const publicSettings = () => {
    const config = readClientSettings(directory, environment);
    return { playbackMode: connectionMode, mode: config.catalogClientId === NCSPOT_CLIENT_ID ? 'shared' : 'custom', clientId: config.catalogClientId,
      redirectUri: config.catalogRedirectUri, readOnly: Boolean(environment.FOLIA_SPOTIFY_CLIENT_ID || environment.FOLIA_SPOTIFY_REDIRECT_URI) };
  };
  return {
    async request(input, progress) {
      if (input?.action === 'configure') {
        if (connectionMode === 'wrapper') throw Object.assign(new Error('SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC'), { code: 'SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC' });
        const task = queue.then(async () => {
          if (closed) throw new Error('Spotify: runtime-closed');
          if (cleanupFailed) throw cleanupFailure;
          if (!['shared', 'custom'].includes(input.settings?.mode)) throw new Error('Spotify: invalid-client-mode');
          const before = publicSettings();
          const value = input.settings?.mode === 'shared' ? { clientId: NCSPOT_CLIENT_ID, redirectUri: 'http://127.0.0.1:8989/login' } : input.settings;
          const saved = await writeClientSettings(directory, value, environment);
          const changed = before.clientId !== saved.catalogClientId || before.redirectUri !== saved.catalogRedirectUri;
          if (changed) {
            const previous = service;
            // Settings remain saved, but the old service stays owned until cleanup succeeds.
            if (previous?.invalidatePlayback) {
              // A client/account change invalidates playback but is not a provider exit.
              // Keep its original route owner until the next real exit or Quit.
              reconfigurePending = true;
              await previous.invalidatePlayback('SESSION_CHANGED');
            } else {
              try { await previous?.close(); }
              catch (error) { cleanupFailed = true; cleanupFailure = error; throw error; }
              service = undefined;
            }
          }
          return { settings: publicSettings(), changed };
        });
        queue = task.catch(() => {}); return task;
      }
      await queue;
      if (closed) throw new Error('Spotify: runtime-closed');
      if (input?.action === 'configuration') return publicSettings();
      if (cleanupFailed) throw cleanupFailure;
      if (reconfigurePending) throw spotifyError('setup-required', 'source-configuration-changed');
      if (!service) service = createService(readClientSettings(directory, environment));
      return service.request(input, progress);
    },
    async leaveProvider() {
      await queue;
      if (closed) throw new Error('Spotify: runtime-closed');
      if (cleanupFailed) throw cleanupFailure;
      await service?.request({ action: 'leaveProvider' });
      if (reconfigurePending) { await service?.close(); service = undefined; reconfigurePending = false; }
    },
    async prepareSourceOutput(url) {
      await queue;
      if (closed) throw new Error('Spotify: runtime-closed');
      if (cleanupFailed) throw cleanupFailure;
      await service?.prepareSourceOutput?.(url);
      if (reconfigurePending) { await service?.close(); service = undefined; reconfigurePending = false; }
    },
    lookupSoloistPcmSource(url) { return closed || cleanupFailed || reconfigurePending ? null : service?.lookupSoloistPcmSource?.(url) || null; },
    requestBrowserPcm(input) { if (closed || !service) throw new Error('Spotify: runtime-closed'); if (cleanupFailed) throw cleanupFailure; if (reconfigurePending) throw spotifyError('setup-required', 'source-configuration-changed'); return service.requestBrowserPcm(input); },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => { await queue; await service?.close(); service = undefined; })();
      void closing.catch(error => { if (isRetryableRouteCleanup(error) || service?.canRetryClose?.(error)) { closing = null; closed = false; } });
      return closing;
    },
  };
}
module.exports = { createSpotifyRuntime };
