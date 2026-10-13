'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createSoloistApplianceSecrets, ensurePrivateDirectory } = require('./soloistApplianceSecrets.cjs');
const { createSoloistApplianceOwner } = require('./soloistApplianceOwner.cjs');
const { createOwnedSoloistAppliance, parseBoundedResponse, publicControlCodes } = require('./soloistOwnedAppliance.cjs');
const { downloadSoloistOfficialAsset } = require('./soloistOfficialAsset.cjs');
const { createSshFailureClassifier, publicSshFailureCodes } = require('./sshFailureClassifier.cjs');
const { secureWindowsPrivateDirectory } = require('./windowsPrivateDirectory.cjs');
const { soloistStartupDiagnosticsCommand, validateSoloistStartupDiagnostics } = require('./soloistStartupDiagnostics.cjs');
const { publishPreviewDiagnostic } = require('../debug/privatePreviewDiagnosticBus.cjs');
const fail = code => Object.assign(new Error(`Spotify appliance: ${code}`), { code });
const levels = Object.freeze({ standard: ['high', 3], high: ['very_high', 4], lossless: ['lossless', 5] });
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cancellation = signal => { if (signal?.aborted) throw fail('CANCELLED'); };
const awaitSignal = (promise, signal) => {
  if (!signal) return promise; if (signal.aborted) return Promise.reject(fail('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('CANCELLED')); signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};
const publicCodes = new Set([...publicControlCodes, ...publicSshFailureCodes, ...`CANCELLED INVALID_QUALITY CODEC_DIAGNOSTICS_UNAVAILABLE APPLIANCE_CLOSED APPLIANCE_CHANGED
  APPLIANCE_COMPONENT_UNAVAILABLE APPLIANCE_COMPONENT_INVALID APPLIANCE_COMPONENT_CHANGED
  SECRET_ENCRYPTION_REQUIRED SECRET_DIRECTORY_UNSAFE SECRET_VAULT_INVALID SECRET_VAULT_WRITE_FAILED SOLOIST_KEY_REQUIRED SOLOIST_KEY_INVALID
  APPLIANCE_PREPARATION_FAILED SOLOIST_DOWNLOAD_FAILED SOLOIST_ASSET_UNVERIFIED APPLIANCE_CHANNEL_UNAVAILABLE
  GUEST_REQUEST_TOO_LARGE GUEST_PROTOCOL_INVALID GUEST_CONTROL_TIMEOUT APPLIANCE_UNAVAILABLE ASSET_INSTALL_UNCONFIRMED
  CREDENTIALS_NOT_READY APPLIANCE_RUNTIME_STARTING APPLIANCE_RUNTIME_TIMEOUT APPLIANCE_SSH_NOT_READY SOLOIST_START_TIMEOUT
  RUNTIME_IDENTITY_CLEANUP_FAILED OWNED_PROTOCOL_INVALID QUALITY_PROTOCOL_INVALID QUALITY_CONFIGURATION_FAILED
  QUALITY_PAIRING_REQUIRED PUBLIC_CONTROL_UNTRUSTED PRIVATE_RUNTIME_REQUIRED PRIVATE_CREDENTIAL_UNSAFE PRIVATE_CREDENTIAL_CHANGED
  QUALITY_BUSY QUALITY_LOCK_UNSAFE PAUSED_OWNED_SOURCE_REQUIRED PROVIDER_QUALITY_UNKNOWN QUALITY_SAVE_UNCONFIRMED
  QUALITY_RESTORE_UNCONFIRMED QUALITY_READBACK_UNCONFIRMED MA_COMMAND_REJECTED MA_RESPONSE_INVALID MA_AUTH_REQUIRED
  PROVIDER_OWNER_CHANGED RECEIVER_CREDENTIAL_UNSAFE RECEIVER_STATUS_UNAVAILABLE PCM_SESSION_BUSY EXTERNAL_PLAYBACK_CHANGE
  PROVIDER_UNLOAD_TIMEOUT PROVIDER_RESTORE_TIMEOUT ASSET_REQUEST_TOO_LARGE ASSET_REQUEST_INVALID ASSET_ARCHIVE_MISMATCH
  ASSET_ARCHIVE_INVALID ASSET_EXTRACTED_TOO_LARGE ASSET_ELF_INVALID ASSET_INSTALL_UNSAFE ASSET_RUNTIME_ALREADY_STARTED
  ASSET_BINARY_MISMATCH ASSET_CONTRACT_CHANGED ASSET_BUILD_EXPIRED ASSET_BINARY_INVALID ASSET_INSTALL_FAILED
  INVALID_PUBLIC_KEY PUBLIC_KEY_CHANGED UNSAFE_OWNER UNSAFE_DIRECTORY INVALID_HOST_KEY HOST_KEY_CHANGED HOST_KEY_MISMATCH
  UNSAFE_PRIVATE_FILE FIRMWARE_INPUT_TOO_LARGE INVALID_HOST_PORT INVALID_DEVICE_NAME HOST_CONFIGURATION_CHANGED
  INVALID_CREDENTIALS RUNTIME_CREDENTIAL_CHANGED BOOT_INPUT_MISSING BOOT_PERMISSION_DENIED APPLIANCE_BOOT_FAILED
  DISCOVERY_PROTOCOL_INVALID DISCOVERY_IDENTITY_CHANGED DISCOVERY_UNAVAILABLE DISCOVERY_INTERFACE_UNAVAILABLE
  PRIVATE_DIRECTORY_UNSAFE PRIVATE_DIRECTORY_CHANGED PRIVATE_DIRECTORY_PERMISSION_FAILED PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE
  PRIVATE_DIRECTORY_CONTROL_TIMEOUT PRIVATE_DIRECTORY_PROTOCOL_INVALID`.split(/\s+/)]);
const publicError = error => publicCodes.has(error?.code) ? error.code
  : error?.code === 'request-cancelled' ? 'CANCELLED'
  : /^soloist-(?:download|archive|platform|main)/.test(error?.code || '') ? 'SOLOIST_DOWNLOAD_FAILED' : 'APPLIANCE_PREPARATION_FAILED';
const commands = Object.freeze({ ports: '/usr/bin/python3 -I /opt/folia/appliance-boot.py ports',
  credentials: '/usr/bin/python3 -I /opt/folia/appliance-boot.py credentials',
  install: '/usr/bin/python3 -I /opt/folia/install-soloist-asset.py',
  status: '/usr/bin/python3 -I /opt/folia/appliance-runtime-status.py',
  quality: '/opt/folia/venv/bin/python -I /opt/folia/owned-appliance-quality.py',
  startupDiagnostics: soloistStartupDiagnosticsCommand });
function createGuestRunner({ spawnProcess = spawn } = {}) {
  return function runGuest({ channel, operation, input = {}, signal, timeoutMs = 20000, finishOnAbort = false }) {
    cancellation(signal); if (!Object.hasOwn(commands, operation)) throw fail('INVALID_REQUEST');
    if (operation === 'startupDiagnostics' && !keys(input, '')) throw fail('INVALID_REQUEST');
    const body = Buffer.from(JSON.stringify(input)); const maximum = operation === 'install' ? 90 * 1024 * 1024 : 16384;
    if (body.length > maximum) { body.fill(0); throw fail('GUEST_REQUEST_TOO_LARGE'); }
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, length = 0; const blocks = [];
      const sshFailure = createSshFailureClassifier();
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        body.fill(0); blocks.forEach(block => block.fill(0)); sshFailure.dispose();
        if (error) { try { child?.kill(); } catch { /* Owned SSH already exited. */ } reject(error); } else resolve(result);
      };
      const abort = () => { if (!finishOnAbort) finish(fail('CANCELLED')); };
      const known = channel.knownHostsPath.replace(/\\/g, '/');
      const args = ['-i', channel.keyPath, '-p', String(channel.sshPort), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'UserKnownHostsFile="' + known + '"',
        'folia@127.0.0.1', commands[operation]];
      try { child = spawnProcess(channel.sshExecutablePath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')); return; }
      child.on('error', () => finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')));
      child.stdin.on('error', () => finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')));
      // Keep only bounded known error enums. Raw control-channel stderr never
      // reaches the renderer, console or a diagnostic report.
      child.stderr?.on('data', bytes => { if (!settled) sshFailure.append(bytes); });
      child.stderr?.on('error', () => sshFailure.dispose());
      child.stdout.on('data', bytes => {
        if (settled) return; length += bytes.length;
        if (length > 8192) finish(fail('GUEST_PROTOCOL_INVALID')); else blocks.push(Buffer.from(bytes));
      });
      child.on('close', code => {
        if (settled) return;
        if (signal?.aborted) { finish(fail('CANCELLED')); return; }
        try {
          if (length === 0) {
            if (operation === 'ports' && code === 0) finish(null, { portsReady: true });
            else { const classified = sshFailure.classify();
              finish(fail(classified === 'APPLIANCE_CHANNEL_UNAVAILABLE' && operation === 'quality' ? 'QUALITY_CONFIGURATION_FAILED' : classified)); }
            return;
          }
          const output = Buffer.concat(blocks, length);
          let value; try { value = parseBoundedResponse(output); } finally { output.fill(0); }
          if (code !== 0) {
            if (!keys(value, 'code,ok') || value.ok !== false || !publicCodes.has(value.code)) throw Error();
            finish(fail(value.code)); return;
          }
          // ports succeeds without output; all other fixed helpers project only known public fields.
          if (operation === 'credentials' && keys(value, 'credentialsReady,ok') && value.ok === true && value.credentialsReady === true) {
            finish(null, { credentialsReady: true }); return;
          }
          if (!keys(value, 'ok,result') || value.ok !== true) throw Error();
          finish(null, operation === 'startupDiagnostics' ? validateSoloistStartupDiagnostics(value.result) : value.result);
        } catch { finish(fail('GUEST_PROTOCOL_INVALID')); }
      });
      timer = setTimeout(() => finish(fail('GUEST_CONTROL_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); if (settled) return; }
      try { child.stdin.end(body); } catch { finish(fail('APPLIANCE_CHANNEL_UNAVAILABLE')); }
    });
  };
}
function createSoloistApplianceComposition({ directory, safeStorage, ownerOptions, deviceName = 'Folia Spotify', diagnostics = false,
  sshExecutablePath, sshExecutableSha256, createOwner = createSoloistApplianceOwner,
  createOwned = createOwnedSoloistAppliance, downloadOfficialAsset = downloadSoloistOfficialAsset,
  runGuestCommand, createDiscovery = require('./soloistDiscovery.cjs').createSoloistDiscovery, io = fs,
  secureRuntimeDirectory = process.platform === 'win32' ? secureWindowsPrivateDirectory : async () => {},
  delay = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal }),
  now = Date.now, readinessTimeoutMs = 150000 } = {}) {
  if (process.type === 'renderer' || typeof directory !== 'string' || !path.isAbsolute(directory) || /[\r\n\0"]/.test(directory)
    || typeof sshExecutablePath !== 'string' || !path.isAbsolute(sshExecutablePath) || /[\r\n\0"]/.test(sshExecutablePath)
    || !digest(sshExecutableSha256) || !ownerOptions || typeof ownerOptions !== 'object' || typeof diagnostics !== 'boolean'
    || ![createOwner, createOwned, downloadOfficialAsset, secureRuntimeDirectory].every(value => typeof value === 'function')
    || createDiscovery != null && typeof createDiscovery !== 'function'
    || typeof deviceName !== 'string' || !deviceName.length || deviceName !== deviceName.trim() || Buffer.byteLength(deviceName) > 128 || /[\x00-\x1f\x7f]/.test(deviceName)
    || !Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 100 || readinessTimeoutMs > 300000) throw fail('INVALID_REQUEST');
  const vault = createSoloistApplianceSecrets({ directory, safeStorage, io }); const execute = runGuestCommand || createGuestRunner();
  let generation = 0, current = null, starting = null, stopping = null, disposed = false;
  let state = 'unconfigured', lastCode; const qualityControls = new Set(); let qualityQueue = Promise.resolve();
  const signalFor = (session, signal) => signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
  const publicStatus = async () => {
    let hasKey;
    try { ({ hasKey } = await vault.publicStatus()); }
    catch (error) { return Object.freeze({ hasKey: false, state: 'failed', code: publicError(error) }); }
    if (!hasKey && state !== 'starting') state = 'unconfigured'; else if (hasKey && state === 'unconfigured') state = 'stopped';
    if (current?.ready && !stopping && !disposed) {
      const session = current;
      try {
        live(session); const fresh = await readStatusFresh(session); live(session);
        state = fresh.authState?.logged_in === true ? 'ready' : 'pairing-required'; lastCode = undefined;
      } catch (error) { if (current === session && !stopping && !disposed) { state = 'failed'; lastCode = publicError(error); } }
    }
    return Object.freeze({ hasKey, state, ...(lastCode ? { code: lastCode } : {}) });
  };
  const progress = (session, stage, extra = {}) => {
    if (current !== session) return; const value = Object.freeze({ stage, ...extra });
    for (const listener of session.progress) { try { listener(value); } catch { /* UI listeners do not control installation. */ } }
  };
  function live(session) {
    if (disposed || current !== session || session.generation !== generation || session.abort.signal.aborted) throw fail('CANCELLED');
    if (session.lease) {
      const status = session.owner.status();
      if (status?.state !== 'running' || status.pid !== session.lease.pid || status.startedAt !== session.lease.startedAt
        || Object.keys(session.lease.ports).some(key => status.ports?.[key] !== session.lease.ports[key])) throw fail('APPLIANCE_CHANGED');
    }
  }
  async function readStatusFresh(session) {
    live(session);
    try {
      const fresh = await session.owned.readFresh({ signal: session.abort.signal }); live(session); return fresh;
    } catch (error) {
      live(session);
      // Actual startup/pairing observations recovered immediately after these
      // two read-only failures. Retry once; owner and protocol failures remain fatal.
      if (!['ZC_CONTROL_UNAVAILABLE', 'OWNED_CONTROL_UNAVAILABLE'].includes(error.code)) throw error;
      await awaitSignal(delay(250, session.abort.signal), session.abort.signal); live(session);
      const fresh = await session.owned.readFresh({ signal: session.abort.signal }); live(session); return fresh;
    }
  }
  async function removeRuntime(session) {
    if (!session.runtimeDirectory) return;
    for (const [filename, witness] of session.files) {
      try {
        const entry = await io.lstat(filename);
        if (entry.isSymbolicLink() || entry.dev !== witness.dev || entry.ino !== witness.ino) throw fail('RUNTIME_IDENTITY_CLEANUP_FAILED');
        const handle = await io.open(filename, 'r+');
        try {
          const actual = await handle.stat(); if (!actual.isFile() || actual.dev !== witness.dev || actual.ino !== witness.ino || actual.size > 16384) continue;
          await handle.write(Buffer.alloc(actual.size), 0, actual.size, 0); await handle.sync();
        } finally { await handle.close(); }
        const actual = await io.lstat(filename);
        if (!actual.isSymbolicLink() && actual.dev === witness.dev && actual.ino === witness.ino) await io.unlink(filename);
      } catch (error) { if (error.code !== 'ENOENT') throw fail('RUNTIME_IDENTITY_CLEANUP_FAILED'); }
    }
    try {
      const entry = await io.lstat(session.runtimeDirectory, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink() || !session.runtimeIdentity
        || entry.dev !== session.runtimeIdentity.dev || entry.ino !== session.runtimeIdentity.ino) throw fail('RUNTIME_IDENTITY_CLEANUP_FAILED');
      await io.rmdir(session.runtimeDirectory);
    } catch (error) { if (error.code !== 'ENOENT') throw fail('RUNTIME_IDENTITY_CLEANUP_FAILED'); }
  }
  async function writeRuntime(session, name, contents) {
    const filename = path.join(session.runtimeDirectory, name); const bytes = Buffer.from(contents);
    try { await io.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    finally { bytes.fill(0); }
    session.files.set(filename, await io.lstat(filename)); return filename;
  }
  async function cleanup(session) {
    if (!session.cleanup) session.cleanup = (async () => {
      try { await session.discovery?.close(); } finally {
        try { await session.owner?.close(); } finally { await removeRuntime(session); }
      }
    })();
    return session.cleanup;
  }
  async function poll(session, check, requiredStage) {
    const deadline = now() + readinessTimeoutMs;
    for (;;) {
      live(session);
      try { const value = await check(); live(session); return value; }
      catch (error) {
        live(session);
        if (!['APPLIANCE_CHANNEL_UNAVAILABLE', 'SSH_CONNECTION_REFUSED', 'SSH_CONNECTION_TIMEOUT', 'APPLIANCE_RUNTIME_STARTING', 'SOLOIST_STARTING', 'MA_SERVICE_UNAVAILABLE',
          'ZC_CONTROL_UNAVAILABLE', 'PLAYBACK_UNAVAILABLE', 'AUTH_SCHEMA_INVALID', 'GUEST_CONTROL_TIMEOUT'].includes(error.code)) throw error;
        if (now() >= deadline) throw fail(requiredStage);
        await delay(250, session.abort.signal);
      }
    }
  }
  async function collectStartupDiagnostics(session) {
    if (!session.channel || !session.lease) return;
    const timeout = new AbortController(); let timer;
    const signal = AbortSignal.any([session.abort.signal, timeout.signal]);
    try {
      live(session);
      // This fixed read-only observation has its own bound, including runners
      // that fail to settle after cancellation. It never retries a mutation.
      timer = setTimeout(() => timeout.abort(), 20000);
      const result = await awaitSignal(Promise.resolve().then(() => { cancellation(signal); return execute({ channel: session.channel,
        operation: 'startupDiagnostics', input: {}, signal, timeoutMs: 20000 }); }), signal);
      cancellation(signal); live(session); const diagnostics = validateSoloistStartupDiagnostics(result);
      progress(session, 'startup-diagnostics', { diagnostics }); return diagnostics;
    } catch { /* Diagnostics cannot replace the original startup failure. */ }
    finally { clearTimeout(timer); timeout.abort(); }
  }
  function ensureReady(options = {}) {
    cancellation(options.signal); if (disposed) return Promise.reject(fail('APPLIANCE_CLOSED'));
    if (stopping) return awaitSignal(stopping.then(() => ensureReady(options)), options.signal);
    if (!starting) {
      const session = { generation, abort: new AbortController(), progress: new Set(), files: new Map() }; current = session;
      const preparing = (async () => {
        let archive;
        try {
          const secrets = await vault.loadForRuntime(); live(session); state = 'starting'; lastCode = undefined;
          progress(session, 'official-download');
          archive = await downloadOfficialAsset({ signal: session.abort.signal, onProgress: event => progress(session, 'official-download',
            { loaded: event.loaded, total: event.total }), now }); live(session);
          if (!archive || archive.source !== 'spotify-official-cdn' || archive.architecture !== 'x86_64' || !Buffer.isBuffer(archive.archiveBytes)
            || archive.archiveBytes.length < 18 || archive.archiveBytes.length > 64 * 1024 * 1024
            || !digest(archive.archiveSha256) || !digest(archive.executableSha256)
            || createHash('sha256').update(archive.archiveBytes).digest('hex') !== archive.archiveSha256) throw fail('SOLOIST_ASSET_UNVERIFIED');
          session.assets = Object.freeze({ soloistSha256: archive.executableSha256 });
          await ensurePrivateDirectory(directory, io); live(session);
          session.runtimeDirectory = await io.mkdtemp(path.join(directory, '.appliance-runtime-'));
          const created = await io.lstat(session.runtimeDirectory, { bigint: true });
          if (!created.isDirectory() || created.isSymbolicLink()) throw fail('PRIVATE_DIRECTORY_UNSAFE');
          session.runtimeIdentity = { dev: created.dev, ino: created.ino };
          live(session);
          // A packaged development host can virtualize LOCALAPPDATA. Resolve
          // that alias only when it identifies this same freshly created object.
          const canonical = await io.realpath(session.runtimeDirectory); live(session);
          const resolved = await io.lstat(canonical, { bigint: true });
          if (!resolved.isDirectory() || resolved.isSymbolicLink()
            || resolved.dev !== created.dev || resolved.ino !== created.ino) throw fail('PRIVATE_DIRECTORY_CHANGED');
          session.runtimeDirectory = canonical;
          // POSIX mode bits do not restrict inherited Windows DACLs. Protect the
          // new, empty directory before any plaintext identity is written.
          await secureRuntimeDirectory(session.runtimeDirectory, { signal: session.abort.signal }); live(session);
          const keyPath = await writeRuntime(session, 'client-key', secrets.clientIdentity.privateKey);
          const hostKeyPath = await writeRuntime(session, 'host-key', secrets.hostIdentity.privateKey); live(session);
          session.owner = createOwner({ ...ownerOptions, bootstrapSshPublicKey: secrets.clientIdentity.publicKey,
            bootstrapSshHostKey: { path: hostKeyPath, sha256: createHash('sha256').update(secrets.hostIdentity.privateKey).digest('hex'),
              publicKey: secrets.hostIdentity.publicKey } });
          progress(session, 'appliance-starting'); const lease = await session.owner.start(); live(session);
          if (!lease?.owned || !Number.isSafeInteger(lease.ports?.ssh) || lease.ports.ssh < 1 || lease.ports.ssh > 65535) throw fail('APPLIANCE_UNAVAILABLE');
          session.lease = { ...lease, ports: { ...lease.ports } }; live(session);
          const knownHostsPath = await writeRuntime(session, 'known-hosts', `[127.0.0.1]:${lease.ports.ssh} ${secrets.hostIdentity.publicKey}\n`);
          session.owned = createOwned({ owner: session.owner, keyPath, knownHostsPath, sshExecutablePath, sshExecutableSha256,
            assets: session.assets }); session.channel = await session.owned.getChannel({ signal: session.abort.signal }); live(session);
          progress(session, 'host-ports'); await poll(session, () => execute({ channel: session.channel, operation: 'ports',
            input: { pcm: session.channel.pcmPort, deviceName, ...(diagnostics ? { diagnostics: true } : {}) }, signal: session.abort.signal }), 'APPLIANCE_SSH_NOT_READY');
          progress(session, 'sdk-installing'); const installed = await execute({ channel: session.channel, operation: 'install',
            input: { archiveBase64: archive.archiveBytes.toString('base64'), archiveSha256: archive.archiveSha256,
              executableSha256: archive.executableSha256, downloadedAt: archive.downloadedAt, etag: archive.etag }, signal: session.abort.signal, timeoutMs: 60000 });
          if (!keys(installed, 'archiveSha256,executableSha256,installed') || installed.installed !== true
            || installed.archiveSha256 !== archive.archiveSha256 || installed.executableSha256 !== archive.executableSha256) throw fail('ASSET_INSTALL_UNCONFIRMED');
          archive.archiveBytes.fill(0); archive = null; live(session);
          progress(session, 'credentials'); const credentials = await execute({ channel: session.channel, operation: 'credentials',
            input: { soloistKey: secrets.soloistKey, maPassword: secrets.maPassword }, signal: session.abort.signal });
          if (!keys(credentials, 'credentialsReady') || credentials.credentialsReady !== true) throw fail('CREDENTIALS_NOT_READY');
          progress(session, 'music-assistant-starting');
          await poll(session, async () => {
            const value = await execute({ channel: session.channel, operation: 'status', signal: session.abort.signal });
            if (!keys(value, 'credentialsReady,maReady,receiverReady,stage') || [value.credentialsReady, value.maReady, value.receiverReady].some(flag => typeof flag !== 'boolean')
              || !['credentials-required', 'music-assistant-starting', 'receiver-starting', 'ready'].includes(value.stage)) throw fail('GUEST_PROTOCOL_INVALID');
            progress(session, value.stage);
            if (!value.credentialsReady || !value.maReady || !value.receiverReady || value.stage !== 'ready') throw fail('APPLIANCE_RUNTIME_STARTING');
            return value;
          }, 'APPLIANCE_RUNTIME_TIMEOUT');
          let fresh = await poll(session, () => readStatusFresh(session), 'SOLOIST_START_TIMEOUT'); live(session);
          const startupReadiness = value => {
            if (!keys(value?.authState, 'is_active,logged_in')
              || Object.values(value.authState).some(flag => typeof flag !== 'boolean')) throw fail('OWNED_PROTOCOL_INVALID');
            return value.authState.logged_in ? 'ready' : 'pairing-required';
          };
          startupReadiness(fresh);
          if (createDiscovery) {
            session.discovery = createDiscovery({ getChannel: async ({ signal } = {}) => {
                // A readiness retry must not let getChannel restart a lost owner.
                live(session);
                const channel = await session.owned.getChannel({ signal: signalFor(session, signal) }); live(session); return channel;
              },
              readFresh: async ({ signal } = {}) => {
                live(session);
                const observed = await session.owned.readFresh({ signal: signalFor(session, signal) }); live(session);
                // Discovery already reads the owned daemon. Its latest observation
                // supersedes the initial one without another read or receiver start.
                startupReadiness(observed); fresh = observed; return observed;
              }, deviceName, observe: event => publishPreviewDiagnostic('spotify.discovery', event) });
            await session.discovery.start({ signal: session.abort.signal }); live(session);
          }
          state = startupReadiness(fresh);
          session.ready = true; progress(session, state); return session;
        } catch (error) {
          const code = publicError(error);
          const diagnostics = code === 'APPLIANCE_RUNTIME_TIMEOUT' ? await collectStartupDiagnostics(session) : undefined;
          if (current === session) { state = code === 'SOLOIST_KEY_REQUIRED' ? 'unconfigured' : code === 'CANCELLED' ? 'stopped' : 'failed'; lastCode = code; }
          await cleanup(session).catch(() => {});
          const failure = fail(code);
          if (diagnostics) Object.defineProperty(failure, 'diagnostics', { value: diagnostics });
          throw failure;
        } finally { archive?.archiveBytes?.fill(0); }
      })();
      starting = preparing; preparing.catch(() => { if (starting === preparing) starting = null; });
    }
    if (typeof options.onProgress === 'function') current.progress.add(options.onProgress);
    return awaitSignal(starting, options.signal);
  }
  async function stopSetup() {
    if (stopping) return stopping;
    const session = current, preparing = starting; generation++; current = null; starting = null; session?.abort.abort();
    state = 'stopped'; lastCode = undefined;
    stopping = (async () => {
      // Finish any already dispatched quality recovery before the owned guest
      // is stopped. A pending initial VM start can instead be cancelled now.
      if (session?.owner && !session.qualityRunning) await session.owner.close();
      await Promise.allSettled([...(preparing ? [preparing] : []), ...qualityControls]);
      if (session) await cleanup(session);
      const { hasKey } = await vault.publicStatus(); state = hasKey ? 'stopped' : 'unconfigured';
    })();
    try { await stopping; } finally { stopping = null; }
  }
  const ownedSoloist = Object.freeze({
    async readFresh(options = {}) {
      const session = await ensureReady(options); live(session);
      const result = await session.owned.readFresh({ signal: signalFor(session, options.signal) }); live(session);
      state = result.authState?.logged_in === true ? 'ready' : 'pairing-required'; return result;
    },
    async seekOwnedPaused(request, options = {}) { const session = await ensureReady(options); live(session);
      const result = await session.owned.seekOwnedPaused(request, { signal: signalFor(session, options.signal) }); live(session); return result; },
    async markCodecDiagnostics(request, options = {}) {
      cancellation(options.signal); if (!diagnostics) throw fail('CODEC_DIAGNOSTICS_UNAVAILABLE');
      const session = await ensureReady(options); live(session);
      const result = await session.owned.markCodecDiagnostics(request, { signal: signalFor(session, options.signal) }); live(session); return result;
    },
    async readCodecDiagnosticsSince(request, options = {}) {
      cancellation(options.signal); if (!diagnostics) throw fail('CODEC_DIAGNOSTICS_UNAVAILABLE');
      const session = await ensureReady(options); live(session);
      const result = await session.owned.readCodecDiagnosticsSince(request, { signal: signalFor(session, options.signal) }); live(session); return result;
    },
  });
  const applyQuality = (quality, options = {}) => {
    if (!Object.hasOwn(levels, quality)) return Promise.reject(fail('INVALID_QUALITY'));
    if (disposed || stopping) return Promise.reject(fail(disposed ? 'APPLIANCE_CLOSED' : 'CANCELLED'));
    const requestedGeneration = generation;
    const pending = qualityQueue.catch(() => {}).then(async () => {
      if (requestedGeneration !== generation || stopping) throw fail('CANCELLED');
      const session = await ensureReady(options); cancellation(options.signal); live(session);
      session.qualityRunning = true; let result;
      try { result = await execute({ channel: session.channel, operation: 'quality',
        input: { requestedQuality: quality, soloistSha256: session.assets.soloistSha256 },
        signal: session.abort.signal, timeoutMs: 90000, finishOnAbort: true }); }
      catch (error) {
        if (error.code === 'QUALITY_PAIRING_REQUIRED' && current === session && !session.abort.signal.aborted) {
          // A public error is not an auth observation. Refresh the owned SDK
          // before changing the UI's pairing state.
          try { const fresh = await session.owned.readFresh({ signal: session.abort.signal }); live(session);
            state = fresh.authState?.logged_in === true ? 'ready' : 'pairing-required'; lastCode = error.code;
          } catch { /* Retain the original quality failure without fabricating auth. */ }
        }
        throw fail(publicError(error));
      }
      finally { session.qualityRunning = false; }
      cancellation(options.signal); live(session); const [level, tier] = levels[quality];
      if (!keys(result, 'configurationApplied,engineTier,providerLevel,reloaded,requestedQuality,sourceQuality')
        || result.configurationApplied !== true || result.requestedQuality !== quality || result.providerLevel !== level
        || result.engineTier !== tier || typeof result.reloaded !== 'boolean' || result.sourceQuality !== null) throw fail('QUALITY_PROTOCOL_INVALID');
      return Object.freeze({ ...result });
    });
    qualityQueue = pending; qualityControls.add(pending); pending.finally(() => qualityControls.delete(pending)).catch(() => {}); return pending;
  };
  const configuration = Object.freeze({ ownedSoloist, deviceName, applyQuality,
    async resolveControlConfiguration(options = {}) { const session = await ensureReady(options); live(session);
      return session.owned.getChannel({ signal: signalFor(session, options.signal) }); } });
  return Object.freeze({
    async saveKey(key) { if (disposed) throw fail('APPLIANCE_CLOSED');
      if (typeof key !== 'string' || !/^spak_[A-Za-z0-9]{20,128}$/.test(key)) throw fail('SOLOIST_KEY_INVALID');
      if (current) await stopSetup(); await vault.saveKey(key); state = 'stopped'; lastCode = undefined; return publicStatus(); },
    publicStatus,
    async startSetup(options = {}) { await ensureReady(options); return publicStatus(); },
    stopSetup, logout: stopSetup,
    async close() { disposed = true; await stopSetup(); },
    getSoloistConfiguration() { if (disposed) throw fail('APPLIANCE_CLOSED'); return configuration; },
  });
}
module.exports = { createSoloistApplianceComposition, createGuestRunner };
