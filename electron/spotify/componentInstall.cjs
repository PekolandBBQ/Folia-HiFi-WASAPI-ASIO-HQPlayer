'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const bundle = require('./componentBundle.json');
const { fail } = require('./componentPackage.cjs');
// One resumable operation owns the component set; existing installations are reused.
function createComponentInstall({ directory, inspect, installSpicetify, configureSpicetify, prepareEngine, installDriver,
  prepareConfiguration = async () => {}, connect = async () => {},
  checkLatest = async () => {}, getBundle = () => bundle, bootTime = () => Date.now() - os.uptime() * 1000, log = () => {} }) {
  let active, state = { phase: 'idle', bundleVersion: bundle.version };
  const receipt = path.join(directory, 'component-install.json');
  async function record(phase, extra = {}) {
    state = { ...state, ...extra, bundleVersion: getBundle().version, phase, updatedAt: Date.now() };
    await fs.mkdir(directory, { recursive: true });
    const temporary = receipt + '.tmp'; await fs.writeFile(temporary, JSON.stringify(state)); await fs.rename(temporary, receipt);
    log('spotify-component-install', { phase, bundleVersion: getBundle().version, code: state.code, failureStage: state.failureStage, detail: state.detail });
  }
  async function run(operation, refreshResources = false) {
    await status();
    // Resource-only repair keeps the currently installed native/CLI bundle. It is not a component upgrade.
    await record(refreshResources ? 'checking-resources' : 'checking-updates', { code: undefined, detail: undefined, failureStage: undefined, operation });
    if (!refreshResources) await checkLatest();
    if (state.restartRequired) { await record('restart-required'); return; }
    await record('checking', { code: undefined, operation });
    let current = await inspect();
    if (!current.installations.length) throw fail(current.detectionFailed ? 'SPOTIFY_DISCOVERY_FAILED' : 'SPOTIFY_NOT_INSTALLED');
    if (!current.selected) throw fail('SPOTIFY_INSTALL_CHOICE_REQUIRED');
    if (operation === 'install') {
      if (!current.engine) { await record('engine'); await prepareEngine(); }
      // Revalidate even an existing package; acquisition reuses it only after content checks.
      await record('spicetify'); await installSpicetify();
      current = await inspect();
      if (!current.driver || current.driverCurrent === false) {
        await record('driver', { driverInstallStartedAt: Date.now() }); await installDriver();
        current = await inspect();
        await record('restart-required', { restartRequired: true }); return;
      }
      if (!current.engine || !current.cli) throw fail('SPOTIFY_COMPONENT_SETUP_INCOMPLETE');
      await record('installed'); return;
    }
    if (!current.engine || !current.cli || !current.driver || current.driverCurrent === false || current.driverEndpointsReady === false) throw fail('SPOTIFY_INSTALL_COMPONENTS_FIRST');
    const reused = current.wrapper && current.extension;
    await record('stopping'); await prepareConfiguration(current);
    await record('configuring'); await configureSpicetify(current, phase => record(phase));
    current = await inspect();
    if (!current.wrapper || !current.extension || !current.engine) throw fail('SPOTIFY_COMPONENT_SETUP_INCOMPLETE');
    await record('connecting'); await connect();
    current = await inspect();
    if (!current.connected) throw fail('SPOTIFY_BRIDGE_NOT_READY');
    await record('complete', { reused });
  }
  async function status() {
      if (state.phase === 'idle') {
        try { state = JSON.parse(await fs.readFile(receipt, 'utf8')); if (!['complete', 'installed', 'failed', 'restart-required'].includes(state.phase)) state.phase = 'interrupted'; }
        catch (e) { if (e.code !== 'ENOENT') state = { phase: 'failed', bundleVersion: bundle.version, code: 'SPOTIFY_COMPONENT_RECEIPT_UNREADABLE' }; }
      }
      // Reopening Folia is not a Windows restart. Recheck live endpoints after a later OS boot.
      if (state.restartRequired && bootTime() > state.driverInstallStartedAt) {
        const current = await inspect();
        await record(current.driver && current.driverEndpointsReady !== false ? 'installed' : 'verification-required', { restartRequired: false });
      }
      return { ...state, busy: Boolean(active) };
  }
  return {
    status,
    start(operation, { refreshResources = false } = {}) {
      if (!['install', 'configure'].includes(operation)) throw fail('SPOTIFY_SETUP_OPERATION_INVALID');
      if (!active) active = run(operation, operation === 'configure' && refreshResources).catch(e => record('failed', { code: e.code || 'SPOTIFY_COMPONENT_SETUP_FAILED', failureStage: state.phase, detail: require('./failureDetails.cjs').failureDetails(e, state.phase).detail })).finally(() => { active = null; });
      return { ...state, busy: true };
    },
    settled: () => active,
  };
}
module.exports = { createComponentInstall, bundle };
