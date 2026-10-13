const path = require('node:path');
const { createSoloistHttpBootstrap } = require('./soloistHttpBootstrap.cjs');
const { createSoloistHttpInvoker } = require('./soloistHttpInvoke.cjs');
const { createSoloistPcmClient } = require('./soloistPcmClient.cjs');

// electron/spotify/soloistRuntime.cjs: one main-owned control runtime, shared by the existing Spotify service.
// Configuration is supplied by the trusted appliance owner, never renderer settings or process discovery.
function createSoloistRuntime({ configuration, createBootstrap = createSoloistHttpBootstrap,
  createInvoker = createSoloistHttpInvoker, createClient = createSoloistPcmClient, fetcher = globalThis.fetch } = {}) {
  const failure = () => Object.assign(new Error('Spotify: soloist-configuration-invalid'), { code: 'unavailable' });
  const cancelled = () => Object.assign(new Error('Spotify Soloist: CANCELLED'), { code: 'CANCELLED' });
  const controlValuesValid = value => value && !Array.isArray(value)
    && ['keyPath', 'knownHostsPath'].every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]) && !/[\r\n\0]/.test(value[key]))
    && (value.sshExecutablePath == null || (typeof value.sshExecutablePath === 'string' && path.isAbsolute(value.sshExecutablePath) && !/[\r\n\0]/.test(value.sshExecutablePath)))
    && ['sshPort', 'pcmPort'].every(key => value[key] == null || (Number.isSafeInteger(value[key]) && value[key] >= 1 && value[key] <= 65535))
    && (value.user == null || ['root', 'folia'].includes(value.user));
  if (process.type === 'renderer') throw failure();
  if (configuration != null && (!configuration || Array.isArray(configuration)
      || Object.keys(configuration).some(key => !['ownedSoloist', 'keyPath', 'knownHostsPath', 'deviceName', 'applyQuality', 'sshPort', 'user', 'pcmPort', 'sshExecutablePath', 'resolveControlConfiguration'].includes(key))
      || !['readFresh', 'seekOwnedPaused'].every(key => typeof configuration.ownedSoloist?.[key] === 'function')
      || (configuration.resolveControlConfiguration != null ? typeof configuration.resolveControlConfiguration !== 'function' : !controlValuesValid(configuration))
      || typeof configuration.deviceName !== 'string' || !configuration.deviceName.trim() || configuration.deviceName.length > 120
      || ['sshPort', 'pcmPort'].some(key => configuration[key] != null && (!Number.isSafeInteger(configuration[key]) || configuration[key] < 1 || configuration[key] > 65535))
      || (configuration.user != null && !['root', 'folia'].includes(configuration.user))
      || /[\r\n\0]/.test(configuration.deviceName) || (configuration.applyQuality != null && typeof configuration.applyQuality !== 'function')))
    throw failure();
  const configured = configuration ? Object.freeze({ ...configuration }) : null;
  const controller = new AbortController();
  let invoke, client, closed = false, channel, initializing;
  function createControlClient(control) {
    const hostPort = control.pcmPort == null ? {} : { pcmPort: control.pcmPort };
    if (!invoke) invoke = createInvoker({ bootstrap: createBootstrap({ keyPath: control.keyPath,
      knownHostsPath: control.knownHostsPath, ...hostPort,
      ...(control.sshPort == null ? {} : { sshPort: control.sshPort }),
      ...(control.user == null ? {} : { user: control.user }),
      ...(control.sshExecutablePath == null ? {} : { executable: control.sshExecutablePath }) }), fetchImpl: fetcher, ...hostPort });
    return createClient({ invoke, fetchImpl: fetcher, ...(control.pcmPort == null ? {} : { port: control.pcmPort }) });
  }
  function resolveControl() {
    if (closed) return Promise.reject(cancelled());
    if (channel) return Promise.resolve(channel);
    if (!initializing) {
      const pending = new Promise((resolve, reject) => {
        const abort = () => { controller.signal.removeEventListener('abort', abort); reject(cancelled()); };
        controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => {
          if (closed || controller.signal.aborted) throw cancelled();
          return configured.resolveControlConfiguration({ signal: controller.signal });
        }).then(value => {
          controller.signal.removeEventListener('abort', abort);
          if (closed || controller.signal.aborted) throw cancelled();
          if (!controlValuesValid(value) || value.user !== 'folia' || !Number.isSafeInteger(value.sshPort) || !Number.isSafeInteger(value.pcmPort)
              || typeof value.sshExecutablePath !== 'string' || !path.isAbsolute(value.sshExecutablePath)) throw failure();
          channel = Object.freeze({ keyPath: value.keyPath, knownHostsPath: value.knownHostsPath,
            sshPort: value.sshPort, user: value.user, pcmPort: value.pcmPort, sshExecutablePath: value.sshExecutablePath });
          resolve(channel);
        }).catch(error => { controller.signal.removeEventListener('abort', abort); reject(error); });
      });
      initializing = pending;
      void pending.catch(() => { if (initializing === pending) initializing = null; });
    }
    return initializing;
  }
  function lazyClient() {
    let created, preparing, disposed = false;
    const ensure = () => {
      if (closed || disposed) return Promise.reject(cancelled());
      if (!preparing) preparing = resolveControl().then(control => {
        if (closed || disposed) throw cancelled();
        created = createControlClient(control); return created;
      }).catch(error => { preparing = null; throw error; });
      return preparing;
    };
    const wrapper = {
      openReadable(session, options = {}) {
        return (async function* () {
          if (options.signal?.aborted) throw cancelled();
          const value = await ensure();
          if (options.signal?.aborted || closed || disposed) throw cancelled();
          yield* value.openReadable(session, options);
        })();
      },
      dispose() {
        if (disposed) return; disposed = true;
        if (client === wrapper) client = null;
        created?.dispose();
      },
    };
    for (const method of ['prepare', 'status', 'play', 'pause', 'seek', 'close']) wrapper[method] = (...args) => ensure().then(value => {
      if (closed || disposed) throw cancelled();
      return value[method](...args);
    });
    return wrapper;
  }
  return Object.freeze({
    getServiceOptions() {
      if (closed) throw Object.assign(new Error('Spotify: runtime-closed'), { code: 'unavailable' });
      if (!configured) return {};
      if (!client) {
        if (configured.resolveControlConfiguration) client = lazyClient();
        else {
          const created = createControlClient(configured);
          let disposed = false;
          const wrapper = { ...created, dispose() {
            if (disposed) return; disposed = true; if (client === wrapper) client = null; created.dispose();
          } };
          client = wrapper;
        }
      }
      return { ownedSoloist: configured.ownedSoloist, soloistPcmClient: client, soloistDeviceName: configured.deviceName,
        ...(configured.applyQuality ? { soloistApplyQuality: configured.applyQuality } : {}) };
    },
    async close() {
      if (closed) return; closed = true; controller.abort();
      try { client?.dispose(); } finally { client = null; invoke?.dispose(); invoke = null; }
    },
  });
}
module.exports = { createSoloistRuntime };
