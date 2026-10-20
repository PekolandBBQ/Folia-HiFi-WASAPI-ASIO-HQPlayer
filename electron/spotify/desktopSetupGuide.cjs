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
function createGuide({ desktop, bridge, apps, capture, route, directory, assetDirectory, existingCli, extension, activateApps, configureEndpoints, endpointsConfigured, log, beforeConfigure,
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
    const issues = []; let captureAvailable = false;
    const issue = (stage, error) => issues.push(require('./failureDetails.cjs').failureDetails(error, stage));
    try { devices = await capture.devices(); captureAvailable = true; endpoints = devices.endpoints || []; driver = endpoints.some(e => e.supportedBaseCable && e.flow === 'capture'); } catch (error) { issue('capture-devices', error); }
    const systemOutput = systemOutputCheck(devices);
    // An outstanding Spotify route is runtime recovery, not a missing component.
    try { const availability = await (route.componentAvailability?.() || route.availability()); engine = availability.supported === true; if (!engine) issue('route-component', { code: availability.code || 'ROUTE_HELPER_UNAVAILABLE' }); } catch (error) { issue('route-component', error); }
    engine = engine && captureAvailable;
    const currentApps = apps();
    try { wrapper = digest(await fs.readFile(path.join(currentApps, 'xpui/helper/spicetifyWrapper.js'))) === currentBundle.spicetify.wrapperSha256; } catch {}
    try { await validateAssets(currentApps, currentBundle); valid = (await fs.readFile(path.join(currentApps, 'xpui/extensions/folia-live-bridge.js'), 'utf8')) === await extension(); if (!valid) issue('bridge-extension', { code: 'SPOTIFY_EXTENSION_UPDATE_REQUIRED' }); } catch (error) { issue('bridge-assets', error); }
    const receipt = await require('./upgradeAssets.cjs').findReceipt(currentApps);
    if (receipt && receipt.receipt.installation !== state.selected) { wrapper = false; valid = false; issue('selected-installation', { code: 'SPOTIFY_CONFIGURATION_VERSION_CHANGED' }); }
    const resource = await require('./resourceVersion.cjs').resourceVersion(currentApps,state.candidates.find(c=>c.id===state.selected));
    if (resource.state === 'mismatch') { wrapper=false; valid=false; issue('bridge-assets',{code:'SPOTIFY_RESOURCE_VERSION_CHANGED'}); }
    let connected = false;
    if (resource.state !== 'mismatch' && state.bridgeRuntime?.state === 'ready') { try { const snapshot = await bridge.request('snapshot'); connected = snapshot.local === true && snapshot.wrapperReady === true && Boolean(snapshot.account && snapshot.deviceId); if (!connected) issue('bridge-player', { code: 'SPOTIFY_PLAYER_NOT_READY' }); } catch (error) { issue('bridge-player', error); } }
    return { enabled: true, bundleVersion: currentBundle.version, versions: { spicetify: currentBundle.spicetify.version, cable: currentBundle.cable.version },
      installations: state.candidates.map(x => ({ id: x.id, layout: x.layout, version: x.version })), selected: state.selected,
      detectionFailed: state.errors.length > 0, running: state.running.length > 0, connected, resource, bridgeRuntime: state.bridgeRuntime, issues, playback: require('./playbackHealth.cjs').get(),
      cli: Boolean(await findCli()), wrapper, extension: valid, driver, driverCurrent: currentDriverVersions?.every(version => version === currentBundle.cable.version)
        && currentDriverVersions.length > 0, updateCheck: updateCheck && { checkedAt: updateCheck.checkedAt, release: updateCheck.release,
          publishedVersion: updateCheck.publishedVersion }, driverEndpointsReady: endpointsConfigured(endpoints), engine, systemOutput,
      ready: Boolean(state.selected) && valid && driver && engine && endpointsConfigured(endpoints) && connected };
  }
  const installer = createComponentInstall({ directory, inspect, log, getBundle: () => currentBundle,
    prepareConfiguration: async () => { await beforeConfigure(); await desktop.stopForConfiguration(); },
    connect: () => desktop.ensure(),
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
      if (current.wrapper) {
        await configureExistingAssets(apps(), await extension(), currentBundle);
      } else if (!current.wrapper) {
        const found = await desktop.inspect(), target = found.candidates.find(c => c.id === current.selected);
        if (!target) throw fail('SPOTIFY_SELECTED_INSTALL_MISSING');
        if (!assetDirectory) throw fail('SPOTIFY_ASSET_DIRECTORY_REQUIRED');
        await fs.mkdir(assetDirectory, { recursive: true });
        const cli = await findCli(), bridgeExtension = await extension();
        const upgraded = await require('./upgradeAssets.cjs').upgradeAssets({ apps: apps(), assetDirectory, target, cli, extension: bridgeExtension, bundle: currentBundle });
        // A separately selected installation owns a separate receipt, never an overwrite of the old selection.
        const old = await require('./upgradeAssets.cjs').findReceipt(apps());
        const changedBuild = (await require('./resourceVersion.cjs').resourceVersion(apps(),target)).state === 'mismatch';
        const suffix = changedBuild ? '-client-' + require('./resourceVersion.cjs').build(target.binaryVersion || target.version) + '-' + require('node:crypto').createHash('sha256').update(target.id).digest('hex').slice(0,12) : old && old.receipt.installation !== target.id ? '-' + require('node:crypto').createHash('sha256').update(target.id).digest('hex').slice(0, 12) : '';
        const assetRoot = upgraded || await configureAssets({ directory: path.join(assetDirectory, currentBundle.version + suffix), target, cli, extension: bridgeExtension, progress, bundle: currentBundle });
        await activateApps(assetRoot);
      }
      await configureEndpoints();
    },
  });
  return { async repairResources() {
    // Join any existing installer before configuring; never start a second backup/apply owner.
    await installer.settled();
    installer.start('configure', { refreshResources: true });
    await installer.settled();
    const result = await installer.status();
    if (result.phase !== 'complete') {
      const error = fail(result.code || (result.restartRequired ? 'SPOTIFY_RESTART_REQUIRED' : 'SPOTIFY_COMPONENT_SETUP_INCOMPLETE'));
      error.detail = result.detail;
      error.stage = result.failureStage;
      throw error;
    }
  }, async request(input, progress) {
    if (input.operation === 'open' && input.component === 'sound') await require('electron').shell.openExternal('ms-settings:sound');
    if (input.operation === 'choose') await desktop.choose(input.installation);
    if (input.operation === 'open' && links[input.component]) await require('electron').shell.openExternal(links[input.component]);
    if (input.operation === 'launch') await desktop.ensure(progress);
    if (input.operation === 'install' || input.operation === 'configure') installer.start(input.operation);
    const install = await installer.status(), current = await inspect();
    return { ...current, ready: current.ready && !install.restartRequired, install };
  } };
}
async function request(options) {
  if (!managers.has(options.desktop)) managers.set(options.desktop, createGuide(options));
  return managers.get(options.desktop).request(options.input, options.progress);
}
async function repairResources(options) {
  if (!managers.has(options.desktop)) managers.set(options.desktop, createGuide(options));
  return managers.get(options.desktop).repairResources();
}
module.exports = { request, createGuide, repairResources };
