'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { execFile } = require('node:child_process');
const { desktopScriptPath } = require('./desktopScriptPath.cjs');
const { acquirePackage, digest, fail } = require('./componentPackage.cjs');
const { createComponentInstall, bundle } = require('./componentInstall.cjs');
const { configureAssets, configureExistingAssets, validateAssets } = require('./configureAssets.cjs');
const { systemOutputCheck } = require('./systemOutputCheck.cjs');
const { latestComponentBundle } = require('./latestComponentBundle.cjs');
const { cableDriverVersion } = require('./driverVersion.cjs');
// Two explicit steps share one pinned bundle and one persistent receipt.
const managers = new WeakMap();
const links = { spotify: 'https://www.spotify.com/download/windows/', spicetify: 'https://spicetify.app/docs/getting-started', cable: 'https://vb-audio.com/Cable/' };
function createGuide({ desktop, bridge, apps, capture, route, directory, assetDirectory, existingCli, extension, activateApps, configureEndpoints, endpointsConfigured, log,
  resolveBundle = latestComponentBundle, driverVersions = cableDriverVersion }) {
  const managed = path.join(directory, 'component-packages');
  let cliDirectory, currentBundle = bundle, updateCheck, currentDriverVersions;
  async function findCli() {
    const installed = path.join(managed, 'spicetify', currentBundle.spicetify.version + '-' + currentBundle.spicetify.sha256.slice(0, 12));
    for (const candidate of [cliDirectory, installed, existingCli].filter(Boolean)) {
      try {
        if (digest(await fs.readFile(path.join(candidate, 'spicetify.exe'))) === currentBundle.spicetify.entrySha256
          && digest(await fs.readFile(path.join(candidate, 'jsHelper/spicetifyWrapper.js'))) === currentBundle.spicetify.wrapperSha256) return candidate;
      } catch { /* Try the next explicitly supplied location. */ }
    }
  }
  async function inspect() {
    const state = await desktop.inspect(); let driver = false, engine = false, wrapper = false, valid = false, endpoints = [], devices = {};
    try { devices = await capture.devices(); endpoints = devices.endpoints || []; driver = endpoints.some(e => e.supportedBaseCable && e.flow === 'capture'); } catch {}
    const systemOutput = systemOutputCheck(devices);
    try { engine = (await route.availability()).supported === true; } catch {}
    const currentApps = apps();
    try { wrapper = digest(await fs.readFile(path.join(currentApps, 'xpui/helper/spicetifyWrapper.js'))) === currentBundle.spicetify.wrapperSha256; } catch {}
    try { await validateAssets(currentApps, currentBundle); valid = true; } catch {}
    return { enabled: true, bundleVersion: currentBundle.version, versions: { spicetify: currentBundle.spicetify.version, cable: currentBundle.cable.version },
      installations: state.candidates.map(x => ({ id: x.id, layout: x.layout, version: x.version })), selected: state.selected,
      detectionFailed: state.errors.length > 0, running: state.running.length > 0, connected: bridge.connected(),
      cli: Boolean(await findCli()), wrapper, extension: valid, driver, driverCurrent: currentDriverVersions?.every(version => version === currentBundle.cable.version)
        && currentDriverVersions.length > 0, updateCheck: updateCheck && { checkedAt: updateCheck.checkedAt, release: updateCheck.release,
          publishedVersion: updateCheck.publishedVersion }, driverEndpointsReady: endpointsConfigured(endpoints), engine, systemOutput,
      ready: Boolean(state.selected) && valid && driver && engine && endpointsConfigured(endpoints) && systemOutput.state === 'ready' && bridge.connected() };
  }
  const installer = createComponentInstall({ directory, inspect, log, getBundle: () => currentBundle,
    checkLatest: async () => { updateCheck = await resolveBundle(); currentBundle = updateCheck.bundle; currentDriverVersions = await driverVersions(); },
    installSpicetify: async () => { cliDirectory = await acquirePackage(currentBundle.spicetify, path.join(managed, 'spicetify')); },
    prepareEngine: async () => { throw fail('SPOTIFY_NATIVE_COMPONENT_UNAVAILABLE'); },
    installDriver: async () => {
      // The elevated vendor process must see a physical user-home path, not an app-data view.
      if (!assetDirectory) throw fail('SPOTIFY_ASSET_DIRECTORY_REQUIRED');
      const target = await acquirePackage(currentBundle.cable, path.join(assetDirectory, 'component-packages', 'cable'));
      await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', desktopScriptPath('installCable.ps1'), '-Installer', path.join(target, currentBundle.cable.entry)],
        { windowsHide: true, timeout: 600000 }, e => e ? reject(fail('SPOTIFY_DRIVER_INSTALL_NOT_COMPLETED')) : resolve()));
      currentDriverVersions = await driverVersions();
    },
    configureSpicetify: async (current, progress) => {
      if (current.wrapper && !current.extension) {
        await configureExistingAssets(apps(), await extension(), currentBundle);
      } else if (!current.wrapper) {
        const found = await desktop.inspect(), target = found.candidates.find(c => c.id === current.selected);
        if (!target) throw fail('SPOTIFY_SELECTED_INSTALL_MISSING');
        if (!assetDirectory) throw fail('SPOTIFY_ASSET_DIRECTORY_REQUIRED');
        await fs.mkdir(assetDirectory, { recursive: true });
        const assetRoot = await configureAssets({ directory: path.join(assetDirectory, currentBundle.version), target, cli: await findCli(), extension: await extension(), progress, bundle: currentBundle });
        await activateApps(assetRoot);
      }
      await configureEndpoints();
    },
  });
  return { async request(input) {
    if (input.operation === 'open' && input.component === 'sound') await require('electron').shell.openExternal('ms-settings:sound');
    if (input.operation === 'choose') await desktop.choose(input.installation);
    if (input.operation === 'open' && links[input.component]) await require('electron').shell.openExternal(links[input.component]);
    if (input.operation === 'launch') await desktop.ensure();
    if (input.operation === 'install' || input.operation === 'configure') installer.start(input.operation);
    const install = await installer.status(), current = await inspect();
    return { ...current, ready: current.ready && !install.restartRequired, install };
  } };
}
async function request(options) {
  if (!managers.has(options.desktop)) managers.set(options.desktop, createGuide(options));
  return managers.get(options.desktop).request(options.input);
}
module.exports = { request, createGuide };
