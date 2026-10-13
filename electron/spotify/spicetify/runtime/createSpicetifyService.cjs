'use strict';
const { createSpicetifySource } = require('./spicetifySource.cjs');
const { createBoundedPair } = require('./boundedPair.cjs');

// runtime/createSpicetifyService.cjs: separate main-process construction path, dormant until explicitly called.
function createSpicetifyControl({ port, createController, dependencies }) {
  return bindSourceControl({ source: createSpicetifySource({ port }), createController, dependencies });
}
function bindSourceControl({ source, createController, dependencies }) {
  if (typeof createController !== 'function') throw new TypeError('Main-process controller factory required');
  let control;
  try { control = createController({ ...dependencies, createSourceApi: () => source }); }
  catch (error) { source.close(); throw error; }
  return Object.freeze({ ...control,
    assertSourceAdmission: () => source.authorize(() => {}),
    inspectSourceIntegration: () => source.inspect(),
    async dispose() {
      // The shared service calls this only after its retained provider route has restored and helpers have exited.
      await control.dispose(); source.close();
    },
  });
}
function assembleSourceService({ createControl, ...options }) {
  // Imports are lazy so building/loading this candidate never starts Electron, a network listener, or Spotify.
  const { createCableSpotifyService } = require('../../cableService.cjs');
  let control;
  const service = createCableSpotifyService({ ...options, createControl: dependencies => (control = createControl(dependencies)) });
  return Object.freeze({ ...service, inspectSourceIntegration: () => control.inspectSourceIntegration(), async request(input, ...rest) {
    // Ordinary provider requests reach this gate before catalog/metadata requests, setup, route acquisition or capture.
    if (input?.action === 'audio') {
      try { await control.assertSourceAdmission(); }
      catch (error) { if (error?.code === 'DESKTOP_SOURCE_UNQUALIFIED') error.message = 'Spotify: desktop-source-unqualified'; throw error; }
    }
    return service.request(input, ...rest);
  } });
}
function createSpicetifyService({ port = createBoundedPair().main, ...options }) {
  const { createDesktopPlaybackControl } = require('../../desktopPlaybackControl.cjs');
  return assembleSourceService({ ...options, createControl: dependencies =>
    createSpicetifyControl({ port, createController: createDesktopPlaybackControl, dependencies }) });
}
module.exports = { createSpicetifyControl, createSpicetifyService, bindSourceControl, assembleSourceService };
