'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spotifyError } = require('./errors.cjs');

// Saved endpoint association. Product playback validates and owns temporary routing only on a track click.
const OPERATIONS = new Set(['status', 'devices', 'saveSelection', 'probe', 'openDriver', 'openSoundSettings', 'openCablePanel', 'start', 'stop', 'checkColdRecovery']);
const FIELDS = ['connectDeviceId', 'captureDeviceId', 'renderDeviceId', 'internal44100Confirmed', 'spotifyOnlyConfirmed', 'defaultsConfirmed'];
const emptySelection = () => ({ connectDeviceId: '', captureDeviceId: '', renderDeviceId: '',
  internal44100Confirmed: false, spotifyOnlyConfirmed: false, defaultsConfirmed: false });
const failure = reason => spotifyError('setup-required', reason);
function validateSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key))
      || FIELDS.some(key => key.endsWith('Confirmed') ? typeof value[key] !== 'boolean'
        : typeof value[key] !== 'string' || value[key].length > 512 || /[\x00-\x1f\x7f]/.test(value[key])))
    throw spotifyError('invalid-response', 'invalid-cable-selection');
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}
function projectEndpoint(endpoint) {
  if (!endpoint || endpoint.supportedBaseCable !== true || !['capture', 'render'].includes(endpoint.flow)
      || typeof endpoint.id !== 'string' || endpoint.id.length > 512 || typeof endpoint.name !== 'string') return null;
  return { id: endpoint.id, name: endpoint.name.slice(0, 160) };
}
function createCableSetup({ directory, captureHost, control, routeLifecycle, revokePlayback = async () => {}, platform = process.platform,
  driverDirectory, openPath, openExternal, io = fs, now = Date.now }) {
  const filename = path.join(directory, 'cable-setup.json');
  const preparations = new WeakMap();
  let loaded, config, queue = Promise.resolve(), disposed = false, lastPublic, deviceCache, revision = 0, pending = 0, recoveryController;
  const driverPath = driverDirectory && path.join(driverDirectory, 'VBCABLE_Setup_x64.exe');
  const panelPath = driverDirectory && path.join(driverDirectory, 'VBCABLE_ControlPanel.exe');
  function alive(expected) { if (disposed || expected != null && expected !== revision) throw failure('request-cancelled'); }
  async function load() {
    if (!loaded) loaded = (async () => {
      let text;
      try { text = await io.readFile(filename, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('cable-settings-unreadable'); }
      if (text == null) config = { schema: 1, enabled: false, selection: emptySelection() };
      else {
        try {
          if (text.length > 8192) throw new Error();
          const value = JSON.parse(text);
          if (value.schema !== 1 || typeof value.enabled !== 'boolean') throw new Error();
          // Read earlier private-candidate flags only for compatibility; they confer no routing authority.
          const legacySelection = { ...value.selection }; delete legacySelection.automaticRouteTrialEnabled;
          const selection = validateSelection(legacySelection);
          if (value.automaticRouteSchema != null && value.automaticRouteSchema !== 1
            || value.spotifyClientOutputConfirmed != null && typeof value.spotifyClientOutputConfirmed !== 'boolean') throw new Error();
          if (routeLifecycle) selection.spotifyOnlyConfirmed = value.automaticRouteSchema === 1 && value.spotifyClientOutputConfirmed === true;
          config = { schema: 1, enabled: value.enabled, selection };
        } catch { throw failure('cable-settings-invalid'); }
      }
    })();
    await loaded; alive(); return config;
  }
  async function save(next) {
    await io.mkdir(directory, { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      // Keep all six legacy selection fields. New routing never claims the old manual-VB confirmation.
      const automatic = Boolean(routeLifecycle);
      const persisted = { schema: 1, enabled: next.enabled,
        selection: { ...Object.fromEntries(FIELDS.map(key => [key, next.selection[key]])),
          spotifyOnlyConfirmed: automatic ? false : next.selection.spotifyOnlyConfirmed },
        ...(automatic ? { automaticRouteSchema: 1, spotifyClientOutputConfirmed: next.selection.spotifyOnlyConfirmed } : {}) };
      await io.writeFile(temporary, JSON.stringify(persisted) + '\n', { flag: 'wx', mode: 0o600 });
      await io.rename(temporary, filename); config = next; lastPublic = undefined;
    } catch { await io.unlink(temporary).catch(() => {}); throw failure('cable-settings-save-failed'); }
  }
  async function exists(file) {
    if (!file) return false;
    try { return (await io.stat(file)).isFile(); } catch { return false; }
  }
  async function list(force = false, forPreparation = false, preparation) {
    const expected = revision;
    const local = await captureHost.devices(); alive(expected);
    const prefetched = preparation && control.readPrefetchedDevices(preparation.devices,
      { signal: preparation.signal, session: preparation.session });
    if (!prefetched && (force || !deviceCache || now() - deviceCache.at > 15000)) {
      try { deviceCache = { at: now(), spotify: await control.listDevices(forPreparation ? { forPreparation: true } : undefined) }; }
      catch (error) { deviceCache = { at: now(), spotify: [], code: /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'API_UNAVAILABLE' }; }
      alive(expected);
    }
    const endpoints = Array.isArray(local?.endpoints) ? local.endpoints : [];
    const devices = { spotify: prefetched || deviceCache.spotify,
      capture: endpoints.filter(item => item.flow === 'capture').map(projectEndpoint).filter(Boolean),
      render: endpoints.filter(item => item.flow === 'render').map(projectEndpoint).filter(Boolean) };
    return { devices, spotifyRunning: local?.spotifyRunning === true, code: prefetched ? undefined : deviceCache.code };
  }
  // Ready is an observed local route plus a selected official desktop, never a checkbox-only assertion.
  async function probe({ forceDevices = false, requireEnabled = true, applyFormatLease = false, requireActive = true, forPreparation = false, preparation } = {}) {
    const settings = await load(), expected = revision;
    const selection = { ...settings.selection };
    const base = { backend: 'vb-cable', state: 'stopped', driverInstalled: false, driverBundled: Boolean(driverDirectory),
      driverInstallerAvailable: await exists(driverPath), spotifyRunning: false, selection };
    if (typeof control.inspectLegacyPreparation === 'function') {
      const receipt = await control.inspectLegacyPreparation(); alive(expected);
      if (!receipt || typeof receipt.historicalVolumeRecord !== 'boolean'
        || typeof receipt.sourceControlUnconfirmed !== 'boolean') throw failure('cable-setup-required');
      if (receipt?.historicalVolumeRecord === true || receipt?.sourceControlUnconfirmed === true) {
        const validDevice = typeof receipt.deviceId === 'string' && receipt.deviceId.length > 0 && receipt.deviceId.length <= 256
          && !/[\u0000-\u001f\u007f]/.test(receipt.deviceId);
        const validVolume = Number.isInteger(receipt.originalVolume) && receipt.originalVolume >= 0 && receipt.originalVolume <= 100;
        // Old files are evidence, not permission to change Spotify's volume.
        // An unknown playback write remains a separate source-control failure.
        base.coldRecovery = { required: false, recoverable: false, archived: receipt.historicalVolumeRecord === true,
          unresolvedHistorical: receipt.historicalVolumeRecord === true, sourceControlUnconfirmed: receipt.sourceControlUnconfirmed === true,
          ...(validDevice ? { deviceId: receipt.deviceId } : {}), ...(validVolume ? { originalVolume: receipt.originalVolume } : {}) };
      } else {
        base.coldRecovery = { required: false, recoverable: false };
      }
    }
    if (platform !== 'win32') return lastPublic = { ...base, state: 'unsupported', code: 'WINDOWS_REQUIRED' };
    if (routeLifecycle) {
      // Passive setup can read component metadata, but cannot start a helper or acquire route authority.
      const capability = await routeLifecycle.offer?.() || {};
      alive(expected);
      base.automaticRoute = { enabled: true, supported: capability.supported === true, productionQualified: capability.productionQualified === true,
        eligible: false, sourceOutputDefaultRequired: false, trialAvailable: capability.trialAvailable === true,
        trialAuthorized: capability.trialAuthorized === true };
    }
    let inventory;
    try { inventory = await list(forceDevices, forPreparation, preparation); alive(expected); }
    catch (error) { alive(expected); return lastPublic = { ...base, state: 'failed', code: 'CAPTURE_HELPER_UNAVAILABLE' }; }
    Object.assign(base, inventory, { driverInstalled: inventory.devices.capture.length > 0 && inventory.devices.render.length > 0 });
    if (base.coldRecovery?.sourceControlUnconfirmed) return lastPublic = { ...base, state: 'routing-required', code: 'PLAYBACK_STATE_UNCONFIRMED' };
    if (!base.driverInstalled) return lastPublic = { ...base, state: 'driver-missing' };
    if (!base.spotifyRunning) return lastPublic = { ...base, state: 'spotify-missing' };
    if (!selection.connectDeviceId || !selection.captureDeviceId || !selection.renderDeviceId
        || !inventory.devices.spotify.some(item => item.id === selection.connectDeviceId && item.selectable)
        || !inventory.devices.capture.some(item => item.id === selection.captureDeviceId)
        || !inventory.devices.render.some(item => item.id === selection.renderDeviceId))
      return lastPublic = { ...base, state: 'selection-required', ...(inventory.code ? { code: inventory.code } : {}) };
    if (!routeLifecycle && requireActive && !inventory.devices.spotify.some(item => item.id === selection.connectDeviceId && item.isActive === true))
      return lastPublic = { ...base, state: 'selection-required', code: 'DEVICE_INACTIVE' };
    if (base.automaticRoute?.enabled === true) {
      if (!selection.internal44100Confirmed) return lastPublic = { ...base, state: 'routing-required', code: 'CABLE_INTERNAL_RATE_CONFIRMATION_REQUIRED' };
      if (!selection.spotifyOnlyConfirmed) return lastPublic = { ...base, state: 'routing-required', code: 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED' };
      // Saved choices are available; actual route, session and format proof happen on the playback request.
      return lastPublic = { ...base, automaticRoute: { ...base.automaticRoute, eligible: true },
        state: 'stopped', code: 'AUTOMATIC_ROUTE_ON_PLAY' };
    }
    let result;
    try { result = await captureHost.inspectRoute(selection); alive(expected); }
    catch { alive(expected); return lastPublic = { ...base, state: 'failed', code: 'ROUTE_PROBE_FAILED' }; }
    const eligible = result?.temporaryFormatLeaseEligible === true;
    if (applyFormatLease && eligible) {
      let lease;
      try { lease = await captureHost.formatProbe({ ...selection, temporaryFormatLease: true }); alive(expected); }
      catch (error) { alive(expected); return lastPublic = { ...base, state: 'format-mismatch',
        code: /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'FORMAT_LEASE_FAILED' }; }
      if (lease?.state !== 'released' || lease?.verified !== true || lease?.formatLease?.state !== 'released')
        return lastPublic = { ...base, state: 'format-mismatch', code: /^[A-Z_]{1,80}$/.test(lease?.errorCode || '') ? lease.errorCode : 'FORMAT_LEASE_FAILED' };
      result = lease.configuration;
    }
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    const publicProbe = { captureSampleRate: result?.capture?.mixFormat?.sampleRate,
      renderMixSampleRate: result?.render?.mixFormat?.sampleRate, captureMixSampleRate: result?.capture?.mixFormat?.sampleRate,
      channels: result?.capture?.mixFormat?.channels, routeVerified: result?.route?.spotifyOnlyObserved === true,
      defaultRenderIsCable: issues.includes('CABLE_IS_DEFAULT_RENDER'),
      otherWriterCount: issues.includes('CABLE_SHARED_WITH_OTHER_AUDIO') ? 1 : 0,
      temporaryFormatLease: true, temporaryFormatLeaseEligible: eligible,
      formatLeaseApplied: result?.formatLease?.verified === true };
    Object.assign(base, { probe: publicProbe });
    const formatValid = publicProbe.captureSampleRate === 44100 && publicProbe.renderMixSampleRate === 44100
      && publicProbe.channels === 2 && result?.render?.mixFormat?.channels === 2;
    const pendingLease = eligible && !applyFormatLease && settings.enabled && publicProbe.channels === 2
      && result?.render?.mixFormat?.channels === 2 && issues.every(code => ['CAPTURE_RATE_MISMATCH', 'RENDER_RATE_MISMATCH'].includes(code));
    if ((!formatValid || issues.some(code => /FORMAT|RATE|CHANNEL|ALIGN|ENCOD|BITS/.test(code))) && !pendingLease)
      return lastPublic = { ...base, state: 'format-mismatch', code: 'CABLE_FORMAT_REQUIRED' };
    if ((!result?.ready && !pendingLease) || !publicProbe.routeVerified)
      return lastPublic = { ...base, state: 'routing-required', code: issues[0] || 'ROUTE_OBSERVATION_FAILED' };
    if (!selection.internal44100Confirmed || !selection.spotifyOnlyConfirmed || !selection.defaultsConfirmed)
      return lastPublic = { ...base, state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED' };
    return lastPublic = { ...base, state: requireEnabled && !settings.enabled ? 'stopped' : 'ready',
      ...(pendingLease ? { code: 'FORMAT_LEASE_ON_PLAY' }
        : result?.formatLease?.state === 'released' ? { code: 'FORMAT_LEASE_PROBE_RELEASED' } : {}) };
  }
  async function perform(input) {
    if (!input || input.action !== 'playbackSetup' || !OPERATIONS.has(input.operation)
        || Object.keys(input).some(key => !['action', 'operation', 'selection', 'requestId'].includes(key))
        || input.operation !== 'saveSelection' && input.selection != null)
      throw spotifyError('invalid-response', 'invalid-cable-setup');
    await load();
    switch (input.operation) {
      case 'saveSelection': {
        const selection = validateSelection(input.selection); revision++; recoveryController?.abort(); deviceCache = undefined;
        await revokePlayback({ verifyCaptureStop: Boolean(routeLifecycle) }); alive(); await save({ schema: 1, enabled: false, selection });
        return probe();
      }
      case 'stop':
        revision++; recoveryController?.abort(); await revokePlayback(); alive(); await save({ ...config, enabled: false }); return probe();
      case 'checkColdRecovery': {
        // A stale renderer action may only refresh the archived evidence.
        // It cannot write volume, restore a route or delete the old receipt.
        return probe({ forceDevices: true });
      }
      case 'start': {
        revision++; recoveryController?.abort(); await revokePlayback(); alive();
        const status = await probe({ forceDevices: true, requireEnabled: false, applyFormatLease: true });
        if (status.state !== 'ready') return status;
        await save({ ...config, enabled: true }); return lastPublic = { ...status, state: 'ready' };
      }
      case 'openDriver':
      case 'openCablePanel': {
        if (platform !== 'win32') throw failure('windows-required');
        const target = input.operation === 'openDriver' ? driverPath : panelPath;
        if (!await exists(target)) throw failure('cable-vendor-file-missing');
        revision++; await revokePlayback(); alive();
        // This user-clicked vendor executable retains its own license/UAC UI. No invented silent-install switches.
        const result = await openPath(target); if (result) throw failure('cable-vendor-open-failed');
        return probe();
      }
      case 'openSoundSettings':
        if (platform !== 'win32') throw failure('windows-required');
        await openExternal('ms-settings:apps-volume'); return probe();
      case 'devices': return probe({ forceDevices: true });
      case 'probe':
        revision++; recoveryController?.abort(); await revokePlayback(); alive();
        return probe({ forceDevices: true, requireEnabled: false, applyFormatLease: true });
      default: return probe();
    }
  }
  return {
    request(input) {
      pending++;
      const task = queue.then(() => { alive(); return perform(input); }).finally(() => { pending--; });
      queue = task.catch(() => {}); return task;
    },
    async prefetchSelection({ signal, session } = {}) {
      alive(); if (pending) throw failure('cable-setup-busy');
      signal?.throwIfAborted();
      const settings = await load(), expected = revision;
      alive(expected); signal?.throwIfAborted();
      const selection = { ...settings.selection };
      const devices = await control.prefetchDevices({ signal, session });
      alive(expected); signal?.throwIfAborted();
      const receipt = Object.freeze({});
      preparations.set(receipt, { devices, signal, session, selection, revision: expected });
      return receipt;
    },
    async getSelection({ signal, session, preparation: receipt } = {}) {
      alive(); if (pending) throw failure('cable-setup-busy');
      signal?.throwIfAborted();
      const settings = await load(), expected = revision;
      alive(expected); signal?.throwIfAborted();
      const preparation = receipt && preparations.get(receipt);
      if (receipt) {
        preparations.delete(receipt);
        if (!preparation || preparation.signal !== signal || preparation.session !== session
          || preparation.revision !== expected || FIELDS.some(key => preparation.selection[key] !== settings.selection[key]))
          throw failure('cable-setup-changed');
      }
      // Only an active Play can retry its authenticated unfinished route release.
      // With no retained route debt this is a local no-op, not another probe.
      if (typeof routeLifecycle?.recoverBeforePlay === 'function') {
        await routeLifecycle.recoverBeforePlay({ signal });
        alive(expected); signal?.throwIfAborted();
      }
      // Only active audio preparation can accept an inactive saved target. Status,
      // settings and explicit first-use checks remain observational and never transfer.
      const status = await probe({ forceDevices: true, requireActive: false, forPreparation: true, preparation });
      alive(expected); signal?.throwIfAborted();
      if (status.coldRecovery?.sourceControlUnconfirmed) throw failure('cable-setup-required');
      if (routeLifecycle) {
        if (status.code !== 'AUTOMATIC_ROUTE_ON_PLAY') throw failure('cable-setup-required');
        // A requested song is the only admission point; no renderer profile or persisted opt-in is trusted.
        await routeLifecycle.setTrialEnabled?.(true); alive(expected); signal?.throwIfAborted();
      } else if (status.state !== 'ready') throw failure(status.state === 'format-mismatch' ? 'cable-format-required' : 'cable-setup-required');
      return { deviceId: status.selection.connectDeviceId, captureDeviceId: status.selection.captureDeviceId,
        renderDeviceId: status.selection.renderDeviceId, temporaryFormatLease: true,
        ...(status.automaticRoute?.enabled === true ? { automaticRouting: true } : {}),
        ...(preparation ? { preparationDevices: preparation.devices } : {}) };
    },
    clear() { revision++; recoveryController?.abort(); deviceCache = undefined; lastPublic = undefined; },
    async close() { disposed = true; revision++; recoveryController?.abort(); await queue; },
  };
}
module.exports = { createCableSetup, validateSelection, projectEndpoint };
