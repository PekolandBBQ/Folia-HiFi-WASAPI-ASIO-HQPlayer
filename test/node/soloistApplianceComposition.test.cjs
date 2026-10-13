const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSoloistApplianceComposition, createGuestRunner } = require('../../electron/spotify/soloistApplianceComposition.cjs');
const { createSoloistApplianceSecrets, createSshIdentity, validIdentity } = require('../../electron/spotify/soloistApplianceSecrets.cjs');
const { soloistStartupDiagnosticsCommand } = require('../../electron/spotify/soloistStartupDiagnostics.cjs');
const KEY = 'spak_' + 'x'.repeat(32), tick = () => new Promise(resolve => setImmediate(resolve));
function safeStorage(available = true) {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
  };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-composition-test-')), directory = path.join(root, 'private');
  const calls = [], owners = [], archives = [], discoveries = [], filesystem = []; let downloads = 0, ioCalls = 0, paired = false;
  const storage = options.safeStorage || safeStorage();
  const io = new Proxy(fs, { get(target, name) { const method = target[name]; return typeof method === 'function'
    ? (...args) => { ioCalls++; filesystem.push({ operation: name, filename: args[0] });
      return options.ioOverrides?.[name] ? options.ioOverrides[name](...args) : method.apply(target, args); } : method; } });
  const createOwner = settings => {
    const count = owners.length; const lease = { owned: true, pid: 500 + count, startedAt: `2026-10-03T10:30:0${count}.123Z`,
      ports: { ssh: 51101 + count * 10, musicAssistant: 51102 + count * 10, pcm: 51103 + count * 10, soloist: 51104 + count * 10 },
      baseImage: path.join(root, 'public.qcow2'), overlayImage: path.join(root, 'owned.qcow2') };
    const owner = { settings, starts: 0, closes: 0, state: 'stopped', lease,
      async start() { owner.starts++; owner.state = 'running'; calls.push('owner'); return lease; },
      status() { return { ...lease, state: owner.state }; }, async close() { if (owner.state !== 'closed') owner.closes++; owner.state = 'closed'; } };
    owners.push(owner); return owner;
  };
  const createOwned = ({ owner, keyPath, knownHostsPath, sshExecutablePath }) => {
    const channel = { keyPath, knownHostsPath, sshExecutablePath, user: 'folia', sshPort: owner.lease.ports.ssh,
      pcmPort: owner.lease.ports.pcm, soloistPort: owner.lease.ports.soloist, musicAssistantPort: owner.lease.ports.musicAssistant,
      appliancePid: owner.lease.pid, applianceStartedAt: owner.lease.startedAt };
    return { async getChannel({ signal } = {}) { if (signal?.aborted) throw Object.assign(Error('cancelled'), { code: 'CANCELLED' }); return channel; },
      async readFresh({ signal } = {}) { if (signal?.aborted) throw Object.assign(Error('cancelled'), { code: 'CANCELLED' });
        calls.push('fresh'); const observed = options.freshHook ? await options.freshHook({ signal }) : undefined;
        if (observed !== undefined) return observed;
        return { authState: { logged_in: paired, is_active: paired }, receivedAt: Date.now(),
          zeroConf: { deviceID: 'owned-fixture' }, playback: { status: null, uri: null, durationMs: null, positionMs: null, speed: null } }; },
      async seekOwnedPaused() { return { acknowledged: true, wsPositionObserved: true }; },
      async markCodecDiagnostics(request, control) {
        calls.push('codec-mark'); return options.codecHook ? options.codecHook('mark', request, control)
          : { marker: { offset: 0 }, sourceQuality: null };
      },
      async readCodecDiagnosticsSince(request, control) {
        calls.push('codec-read'); return options.codecHook ? options.codecHook('read', request, control)
          : { events: [], sourceQuality: null, sourceBitDepth: null, sourceEncodingVerified: false };
      } };
  };
  const downloadOfficialAsset = options.download || (async () => {
    downloads++; calls.push('download'); const archiveBytes = Buffer.from('synthetic official archive fixture'); archives.push(archiveBytes);
    return { archiveBytes, archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'), executableSha256: 'b'.repeat(64),
      downloadedAt: 1791000000000, etag: null, source: 'spotify-official-cdn', architecture: 'x86_64' };
  });
  const runGuestCommand = async request => {
    calls.push(request.operation); if (options.command) return options.command(request);
    if (request.operation === 'ports') { assert.equal(request.input.deviceName, 'Folia Spotify'); return { portsReady: true }; }
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') { assert.equal(request.input.soloistKey, KEY); assert.match(request.input.maPassword, /^[A-Za-z0-9_-]{24,128}$/); return { credentialsReady: true }; }
    if (request.operation === 'status') return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
    if (request.operation === 'quality') return { requestedQuality: request.input.requestedQuality,
      providerLevel: { standard: 'high', high: 'very_high', lossless: 'lossless' }[request.input.requestedQuality],
      engineTier: { standard: 3, high: 4, lossless: 5 }[request.input.requestedQuality], configurationApplied: true, reloaded: true, sourceQuality: null };
    throw Error('unexpected fixture command');
  };
  const createDiscovery = settings => {
    const value = { settings, starts: 0, closes: 0, async start() { value.starts++; calls.push('discovery'); }, async close() { value.closes++; } };
    discoveries.push(value); return value;
  };
  const composition = createSoloistApplianceComposition({ directory, safeStorage: storage, ownerOptions: { runtimeDirectory: root },
    sshExecutablePath: path.join(root, 'verified-ssh.exe'), sshExecutableSha256: 'a'.repeat(64), createOwner, createOwned,
    createDiscovery, downloadOfficialAsset, runGuestCommand, io, secureRuntimeDirectory: async () => {}, delay: async () => {}, ...options.changes });
  t.after(async () => {
    await composition.close().catch(() => {});
    const actual = path.resolve(root), allowed = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(actual.startsWith(allowed) && path.basename(actual).startsWith('folia-composition-test-')); await fs.rm(actual, { recursive: true, force: true });
  });
  return { root, directory, composition, calls, owners, archives, discoveries, storage, filesystem,
    pair() { paired = true; }, counts: () => ({ downloads, ioCalls }) };
}

test('main construction and catalog configuration perform no I/O, download, process or discovery start', async t => {
  const value = await fixture(t); const config = value.composition.getSoloistConfiguration();
  assert.equal(typeof config.resolveControlConfiguration, 'function'); assert.equal(typeof config.ownedSoloist.readFresh, 'function');
  assert.deepEqual(value.counts(), { downloads: 0, ioCalls: 0 }); assert.equal(value.owners.length, 0); assert.equal(value.discoveries.length, 0);
});
test('missing key, invalid key and unavailable encryption all fail before any VM or official download', async t => {
  const value = await fixture(t);
  assert.deepEqual(await value.composition.publicStatus(), { hasKey: false, state: 'unconfigured' });
  await assert.rejects(value.composition.startSetup(), { code: 'SOLOIST_KEY_REQUIRED' });
  await assert.rejects(value.composition.saveKey('private-invalid'), { code: 'SOLOIST_KEY_INVALID' });
  assert.equal(value.owners.length, 0); assert.equal(value.counts().downloads, 0);
  const unavailable = await fixture(t, { safeStorage: safeStorage(false) });
  await assert.rejects(unavailable.composition.saveKey(KEY), { code: 'SECRET_ENCRYPTION_REQUIRED' }); assert.equal(unavailable.owners.length, 0);
});
test('saveKey encrypts secrets and SSH identities; public result contains no private material', async t => {
  const value = await fixture(t); assert.deepEqual(await value.composition.saveKey(KEY), { hasKey: true, state: 'stopped' });
  const ciphertext = await fs.readFile(path.join(value.directory, 'appliance-secrets.enc'));
  assert.equal(ciphertext.includes(KEY), false); assert.equal(ciphertext.includes('OPENSSH PRIVATE'), false);
  assert.equal(value.owners.length, 0); assert.equal(value.counts().downloads, 0);
  const stored = JSON.parse(value.storage.decryptString(ciphertext)); assert.equal(validIdentity(stored.clientIdentity), true);
  assert.equal(validIdentity(stored.hostIdentity), true); assert.notEqual(stored.clientIdentity.publicKey, stored.hostIdentity.publicKey);
});
test('start, owned proof and runtime resolution share exactly one pipeline, with credentials last and SDK wiped', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); const config = value.composition.getSoloistConfiguration();
  const [status, channel, fresh] = await Promise.all([value.composition.startSetup(), config.resolveControlConfiguration(), config.ownedSoloist.readFresh()]);
  assert.equal(status.state, 'pairing-required'); assert.equal(fresh.authState.logged_in, false); assert.equal(channel.sshPort, 51101);
  assert.equal(value.owners.length, 1); assert.equal(value.owners[0].starts, 1); assert.equal(value.counts().downloads, 1);
  assert.deepEqual(value.calls.slice(0, 6), ['download', 'owner', 'ports', 'install', 'credentials', 'status']);
  assert.equal(value.archives[0].every(byte => byte === 0), true); assert.equal(value.discoveries[0].starts, 1);
  const knownHosts = await fs.readFile(channel.knownHostsPath, 'utf8');
  assert.equal(knownHosts, `[127.0.0.1]:51101 ${value.owners[0].settings.bootstrapSshHostKey.publicKey}\n`);
  assert.equal(knownHosts.includes(KEY), false);
  assert.equal(createHash('sha256').update(await fs.readFile(value.owners[0].settings.bootstrapSshHostKey.path)).digest('hex'),
    value.owners[0].settings.bootstrapSshHostKey.sha256);
});
test('official pairing changes public status only after a fresh auth observation; status cannot start VM', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); await value.composition.startSetup();
  value.pair(); assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'ready' });
  assert.equal(value.owners.length, 1); assert.equal(value.counts().downloads, 1);
});
test('startup waits for discovery and publishes its latest existing auth read without an extra read', async t => {
  for (const states of [[false, true, true], [true, true, false], [false, false, false]]) {
    let reads = 0, entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const progress = [];
    const value = await fixture(t, { freshHook: async () => {
      const loggedIn = states[reads++];
      assert.equal(typeof loggedIn, 'boolean', 'startup must not add auth reads');
      return { authState: { logged_in: loggedIn, is_active: false } };
    }, changes: { createDiscovery: ({ readFresh }) => ({
      async start() { await readFresh(); await readFresh(); entered(); await held; }, async close() {},
    }) } });
    await value.composition.saveKey(KEY);
    // Resolving the existing channel avoids startSetup's separate publicStatus read.
    const pending = value.composition.getSoloistConfiguration().resolveControlConfiguration({ onProgress: event => progress.push(event.stage) });
    await reached;
    const whileDiscovering = await value.composition.publicStatus();
    release(); await pending;
    assert.deepEqual(whileDiscovering, { hasKey: true, state: 'starting' });
    assert.equal(progress.at(-1), states.at(-1) ? 'ready' : 'pairing-required');
    assert.equal(reads, 3); assert.equal(value.owners[0].starts, 1); assert.equal(value.counts().downloads, 1);
  }
});
test('startup without discovery uses its original auth read and malformed discovery auth cannot become readiness', async t => {
  const ordinary = await fixture(t, { changes: { createDiscovery: null } });
  const progress = []; await ordinary.composition.saveKey(KEY);
  await ordinary.composition.getSoloistConfiguration().resolveControlConfiguration({ onProgress: event => progress.push(event.stage) });
  assert.equal(progress.at(-1), 'pairing-required'); assert.equal(ordinary.calls.filter(item => item === 'fresh').length, 1);
  for (const authState of [null, { logged_in: 'true', is_active: false }, { logged_in: true }, { logged_in: true, is_active: 1 }]) {
    let reads = 0;
    const value = await fixture(t, { freshHook: async () => ++reads === 1
      ? { authState: { logged_in: false, is_active: false } } : { authState },
    changes: { createDiscovery: ({ readFresh }) => ({ async start() { await readFresh(); }, async close() {} }) } });
    await value.composition.saveKey(KEY);
    await assert.rejects(value.composition.getSoloistConfiguration().resolveControlConfiguration(), { code: 'OWNED_PROTOCOL_INVALID' });
    assert.equal(reads, 2); assert.equal(value.owners[0].closes, 1);
  }
});
test('a discovery observation from a changed owner cannot publish startup readiness', async t => {
  let reads = 0, value;
  value = await fixture(t, { freshHook: async () => {
    if (++reads === 2) value.owners[0].lease.pid++;
  }, changes: { createDiscovery: ({ readFresh }) => ({ async start() { await readFresh(); }, async close() {} }) } });
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.getSoloistConfiguration().resolveControlConfiguration(), { code: 'APPLIANCE_CHANGED' });
  assert.equal(reads, 2); assert.equal(value.owners[0].starts, 1); assert.equal(value.owners[0].closes, 1);
});
test('startup status retries only one captured transient read without repeating setup mutations', async t => {
  for (const code of ['ZC_CONTROL_UNAVAILABLE', 'OWNED_CONTROL_UNAVAILABLE']) {
    let reads = 0; const delays = [];
    const value = await fixture(t, { freshHook: async () => {
      if (++reads === 1) throw Object.assign(Error('synthetic transient'), { code });
    }, changes: { delay: async ms => delays.push(ms) } });
    await value.composition.saveKey(KEY); const status = await value.composition.startSetup();
    assert.equal(status.state, 'pairing-required'); assert.deepEqual(delays, [250]); assert.equal(reads, 3);
    for (const operation of ['ports', 'install', 'credentials', 'status'])
      assert.equal(value.calls.filter(call => call === operation).length, 1);
    assert.equal(value.calls.includes('quality'), false); assert.equal(value.owners[0].starts, 1);
  }
});
test('ready status recovers one captured transient from a fresh auth observation', async t => {
  for (const code of ['ZC_CONTROL_UNAVAILABLE', 'OWNED_CONTROL_UNAVAILABLE']) {
    let failure, reads = 0; const delays = [];
    const value = await fixture(t, { freshHook: async () => {
      reads++; if (failure) { failure = undefined; throw Object.assign(Error('synthetic transient'), { code }); }
    }, changes: { delay: async ms => delays.push(ms) } });
    await value.composition.saveKey(KEY); await value.composition.startSetup(); value.pair();
    const before = reads; failure = code;
    assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'ready' });
    assert.equal(reads - before, 2); assert.deepEqual(delays, [250]);
    assert.equal(value.counts().downloads, 1); assert.equal(value.owners[0].starts, 1);
  }
});
test('persistent status failures remain reported after one bounded reread', async t => {
  let reads = 0; const startupDelays = [];
  const startup = await fixture(t, { freshHook: async () => {
    reads++; throw Object.assign(Error('synthetic persistent'), { code: 'OWNED_CONTROL_UNAVAILABLE' });
  }, changes: { delay: async ms => startupDelays.push(ms) } });
  await startup.composition.saveKey(KEY);
  await assert.rejects(startup.composition.startSetup(), { code: 'OWNED_CONTROL_UNAVAILABLE' });
  assert.equal(reads, 2); assert.deepEqual(startupDelays, [250]); assert.equal(startup.owners[0].closes, 1);
  assert.equal(startup.discoveries.length, 0);
  for (const code of ['ZC_CONTROL_UNAVAILABLE', 'OWNED_CONTROL_UNAVAILABLE']) {
    let failure, count = 0; const delays = [];
    const value = await fixture(t, { freshHook: async () => {
      count++; if (failure) throw Object.assign(Error('synthetic persistent'), { code });
    }, changes: { delay: async ms => delays.push(ms) } });
    await value.composition.saveKey(KEY); await value.composition.startSetup(); const before = count; failure = code;
    assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'failed', code });
    assert.equal(count - before, 2); assert.deepEqual(delays, [250]); assert.equal(value.owners[0].starts, 1);
  }
});
test('hard owner hash ancestry protocol and cancellation status errors never retry', async t => {
  for (const code of ['OWNER_CHANGED', 'SOLOIST_BINARY_CHANGED', 'MA_ANCESTRY_MISMATCH', 'OWNED_PROTOCOL_INVALID', 'AUTH_SCHEMA_INVALID', 'CANCELLED']) {
    let failure, count = 0; const delays = [];
    const value = await fixture(t, { freshHook: async () => {
      count++; if (failure) throw Object.assign(Error('synthetic hard failure'), { code });
    }, changes: { delay: async ms => delays.push(ms) } });
    await value.composition.saveKey(KEY); await value.composition.startSetup(); const before = count; failure = code;
    assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'failed', code });
    assert.equal(count - before, 1); assert.deepEqual(delays, []);
  }
});
test('stop during a transient status retry cancels startup or ready reads without publishing late status', async t => {
  for (const phase of ['startup', 'ready']) {
    let failRead = phase === 'startup', reads = 0, release, reached;
    const began = new Promise(resolve => { reached = resolve; });
    const value = await fixture(t, { freshHook: async () => {
      reads++; if (failRead) throw Object.assign(Error('synthetic transient'), { code: 'OWNED_CONTROL_UNAVAILABLE' });
    }, changes: { delay: async (ms, signal) => {
      assert.equal(ms, 250); assert.equal(signal.aborted, false); reached();
      return new Promise(resolve => { release = resolve; });
    } } });
    await value.composition.saveKey(KEY);
    if (phase === 'ready') { await value.composition.startSetup(); failRead = true; }
    const before = reads, pending = phase === 'startup' ? value.composition.startSetup() : value.composition.publicStatus();
    const cancelled = phase === 'startup' ? assert.rejects(pending, { code: 'CANCELLED' }) : undefined;
    await began; await value.composition.stopSetup(); release();
    if (cancelled) await cancelled;
    else assert.deepEqual(await pending, { hasKey: true, state: 'stopped' });
    assert.equal(reads - before, 1); assert.equal(value.owners[0].closes, 1);
    assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'stopped' });
  }
});
test('dynamic quality uses the same ready owner and retains source quality unknown', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); const config = value.composition.getSoloistConfiguration();
  const result = await config.applyQuality('high'); assert.equal(result.providerLevel, 'very_high'); assert.equal(result.sourceQuality, null);
  assert.equal(value.owners.length, 1); assert.equal(value.calls.filter(item => item === 'quality').length, 1);
});
test('codec evidence is opt-in before receiver start and reuses the same owned session without inventing quality', async t => {
  const ports = [];
  const value = await fixture(t, { changes: { diagnostics: true }, command: async request => {
    if (request.operation === 'ports') { ports.push(request.input); return { portsReady: true }; }
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    if (request.operation === 'status') return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
    throw Error('Unexpected command');
  } });
  await value.composition.saveKey(KEY); const owned = value.composition.getSoloistConfiguration().ownedSoloist;
  const marked = await owned.markCodecDiagnostics({ requestedQuality: 'lossless' });
  const read = await owned.readCodecDiagnosticsSince({ marker: marked.marker, expectedUri: 'spotify:track:' + 'A'.repeat(22) });
  assert.deepEqual(ports, [{ pcm: 51103, deviceName: 'Folia Spotify', diagnostics: true }]);
  assert.equal(value.owners.length, 1); assert.equal(value.counts().downloads, 1);
  assert.equal(read.sourceQuality, null); assert.equal(read.sourceBitDepth, null); assert.equal(read.sourceEncodingVerified, false);
});
test('legacy components reject codec diagnostics without downloading or starting a guest and preserve ports schema', async t => {
  const ports = [];
  const value = await fixture(t), owned = value.composition.getSoloistConfiguration().ownedSoloist;
  await assert.rejects(owned.markCodecDiagnostics({ requestedQuality: 'lossless' }), { code: 'CODEC_DIAGNOSTICS_UNAVAILABLE' });
  await assert.rejects(owned.readCodecDiagnosticsSince({}), { code: 'CODEC_DIAGNOSTICS_UNAVAILABLE' });
  assert.equal(value.owners.length, 0); assert.equal(value.counts().downloads, 0);
  const legacy = await fixture(t, { command: async request => {
    if (request.operation === 'ports') { ports.push(request.input); return { portsReady: true }; }
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
  } });
  await legacy.composition.saveKey(KEY); await legacy.composition.startSetup();
  assert.deepEqual(ports, [{ pcm: 51103, deviceName: 'Folia Spotify' }]);
});
test('late codec reads cannot survive stop or owner replacement and caller cancellation reaches the owned helper', async t => {
  let release, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const value = await fixture(t, { changes: { diagnostics: true }, codecHook: async (operation, request, { signal }) => {
    assert.equal(operation, 'read'); assert.equal(signal.aborted, false); reached();
    return new Promise(resolve => { release = () => resolve({ events: [], sourceQuality: null }); });
  } });
  await value.composition.saveKey(KEY);
  const reading = value.composition.getSoloistConfiguration().ownedSoloist.readCodecDiagnosticsSince({});
  const rejected = assert.rejects(reading, { code: 'CANCELLED' });
  await started; await value.composition.stopSetup(); release(); await rejected;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(value.composition.getSoloistConfiguration().ownedSoloist.markCodecDiagnostics({}, { signal: cancelled.signal }), { code: 'CANCELLED' });
  assert.equal(value.owners.length, 1);
});
test('logout closes discovery and owner, wipes ephemeral keys, preserves grant and can create a new owned receiver', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); const grant = path.join(value.root, 'session.enc'); await fs.writeFile(grant, 'unrelated encrypted grant fixture');
  const channel = await value.composition.getSoloistConfiguration().resolveControlConfiguration(); await value.composition.logout();
  assert.equal(value.owners[0].closes, 1); assert.equal(value.discoveries[0].closes, 1);
  await assert.rejects(fs.stat(channel.keyPath), { code: 'ENOENT' }); await assert.rejects(fs.stat(channel.knownHostsPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(grant, 'utf8'), 'unrelated encrypted grant fixture'); assert.equal((await value.composition.publicStatus()).state, 'stopped');
  await value.composition.startSetup(); assert.equal(value.owners.length, 2); assert.equal(value.owners[1].starts, 1);
});
test('discovery receives both lifetime cancellation and its own request cancellation', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); await value.composition.startSetup();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(value.discoveries[0].settings.readFresh({ signal: abort.signal }), { code: 'CANCELLED' });
  await value.composition.stopSetup(); await assert.rejects(value.discoveries[0].settings.getChannel(), { code: 'CANCELLED' });
});
test('stop during official download cancels the shared preparation and no late VM starts', async t => {
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const value = await fixture(t, { download: ({ signal }) => { reached(); return new Promise((resolve, reject) => signal.addEventListener('abort',
    () => reject(Object.assign(Error('cancelled fixture'), { code: 'CANCELLED' })), { once: true })); } });
  await value.composition.saveKey(KEY); const pending = value.composition.startSetup(); const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await started; await value.composition.stopSetup(); await rejected; assert.equal(value.owners.length, 0); assert.equal((await value.composition.publicStatus()).state, 'stopped');
});
test('invalid archive provenance or unconfirmed installer cannot expose a channel or inject secrets', async t => {
  const value = await fixture(t, { download: async () => ({ source: 'guest-self-hash', architecture: 'x86_64' }) });
  await value.composition.saveKey(KEY); await assert.rejects(value.composition.startSetup(), { code: 'SOLOIST_ASSET_UNVERIFIED' }); assert.equal(value.owners.length, 0);
  const invalid = await fixture(t, { command: async request => request.operation === 'ports' ? { portsReady: true } : { installed: true,
    archiveSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) } });
  await invalid.composition.saveKey(KEY); await assert.rejects(invalid.composition.startSetup(), { code: 'ASSET_INSTALL_UNCONFIRMED' });
  assert.equal(invalid.calls.includes('credentials'), false); assert.equal(invalid.owners[0].closes, 1);
});
test('fresh status detects stopped/replaced owner without adopting it or starting another guest', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); await value.composition.startSetup(); value.owners[0].state = 'stopped';
  const status = await value.composition.publicStatus(); assert.equal(status.state, 'failed'); assert.equal(status.code, 'APPLIANCE_CHANGED'); assert.equal(value.owners.length, 1);
});
test('generated OpenSSH identities validate cryptographically and corrupted keys are rejected', () => {
  const identity = createSshIdentity(); assert.equal(validIdentity(identity), true);
  assert.equal(validIdentity({ ...identity, publicKey: createSshIdentity().publicKey }), false);
  assert.equal(validIdentity({ ...identity, privateKey: identity.privateKey.replace('OPENSSH', 'RSA') }), false);
});
test('vault reload keeps MA password and identities stable while changing only the explicit Soloist key', async t => {
  const value = await fixture(t); const vault = createSoloistApplianceSecrets({ directory: value.directory, safeStorage: value.storage });
  await vault.saveKey(KEY); const before = await vault.loadForRuntime(); await vault.saveKey('spak_' + 'y'.repeat(32)); const after = await vault.loadForRuntime();
  assert.equal(after.maPassword, before.maPassword); assert.deepEqual(after.clientIdentity, before.clientIdentity); assert.deepEqual(after.hostIdentity, before.hostIdentity);
  assert.notEqual(after.soloistKey, before.soloistKey);
});
test('fixed guest runner keeps credentials out of argv and contains pipe errors while accepting empty ports ACK', async () => {
  const calls = []; const runner = createGuestRunner({ spawnProcess: (file, args, flags) => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    child.stdin.end = body => { calls.push({ file, args, flags, body: body.toString() }); setImmediate(() => child.emit('close', 0)); }; return child;
  } });
  const channel = { sshExecutablePath: 'C:\\public\\ssh.exe', keyPath: 'C:\\private space\\key', knownHostsPath: 'C:\\private space\\known', sshPort: 51101 };
  assert.deepEqual(await runner({ channel, operation: 'ports', input: { pcm: 51103, deviceName: 'Folia Spotify' } }), { portsReady: true });
  assert.equal(calls[0].args.includes('UserKnownHostsFile="C:/private space/known"'), true);
  assert.equal(calls[0].args.includes('folia@127.0.0.1'), true); assert.equal(calls[0].flags.windowsHide, true);
  assert.deepEqual(calls[0].flags.stdio, ['pipe', 'pipe', 'pipe']);
  const pipe = createGuestRunner({ spawnProcess: () => { const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    child.stdin.end = () => { child.stdin.emit('error', Object.assign(Error('private EPIPE fixture'), { code: 'EPIPE' })); }; return child; } });
  await assert.rejects(pipe({ channel, operation: 'credentials', input: { soloistKey: KEY, maPassword: 'a'.repeat(32) } }), error =>
    error.code === 'APPLIANCE_CHANNEL_UNAVAILABLE' && !error.message.includes(KEY));
});

test('fixed guest response rejects duplicate, non UTF-8, oversized and undeclared error output', async () => {
  const channel = { sshExecutablePath: 'C:\\public\\ssh.exe', keyPath: 'C:\\private\\key', knownHostsPath: 'C:\\private\\known', sshPort: 51101 };
  const run = (bytes, exitCode = 0) => createGuestRunner({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    child.stdin.end = () => setImmediate(() => { child.stdout.emit('data', bytes); child.emit('close', exitCode); }); return child;
  } })({ channel, operation: 'quality', input: { requestedQuality: 'high', soloistSha256: 'b'.repeat(64) } });
  for (const bytes of [Buffer.from('{"ok":true,"result":{"level":"high","level":"lossless"}}'),
    Buffer.from([123, 34, 255, 34, 58, 48, 125]), Buffer.alloc(8193),
    Buffer.from('{"ok":false,"code":"PRIVATE_VALUE_CAN_NOT_ESCAPE"}')]) {
    await assert.rejects(run(bytes, bytes.includes('PRIVATE') ? 1 : 0), { code: 'GUEST_PROTOCOL_INVALID' });
  }
  await assert.rejects(run(Buffer.from('{"ok":false,"code":"QUALITY_PAIRING_REQUIRED"}'), 1), { code: 'QUALITY_PAIRING_REQUIRED' });
  await assert.rejects(run(Buffer.from('{"ok":false,"code":"ASSET_BUILD_EXPIRED"}'), 1), { code: 'ASSET_BUILD_EXPIRED' });
});

test('quality pairing failure requires a fresh auth observation and never mutates OAuth or retries the save', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY); await value.composition.startSetup(); value.pair();
  value.composition.getSoloistConfiguration();
  // A separate command fixture supplies a safe declared failure; no account or actual guest is involved.
  const paired = await fixture(t, { command: async request => {
    if (request.operation === 'ports') return { portsReady: true };
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    if (request.operation === 'status') return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
    if (request.operation === 'quality') throw Object.assign(Error('declared fixture failure'), { code: 'QUALITY_PAIRING_REQUIRED' });
  } });
  await paired.composition.saveKey(KEY); await paired.composition.startSetup(); paired.pair();
  await assert.rejects(paired.composition.getSoloistConfiguration().applyQuality('high'), { code: 'QUALITY_PAIRING_REQUIRED' });
  assert.equal((await paired.composition.publicStatus()).state, 'ready');
  assert.equal(paired.calls.filter(call => call === 'quality').length, 1);
});

test('stop waits for the single automatic reload transaction before closing its owner', async t => {
  let release, reached; const started = new Promise(resolve => { reached = resolve; });
  const value = await fixture(t, { command: async request => {
    if (request.operation === 'ports') return { portsReady: true };
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    if (request.operation === 'status') return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
    if (request.operation === 'quality') { assert.equal(request.finishOnAbort, true); reached(); return new Promise(resolve => { release = () => resolve({}); }); }
  } });
  await value.composition.saveKey(KEY); await value.composition.startSetup();
  const pending = value.composition.getSoloistConfiguration().applyQuality('high'); const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  const queued = value.composition.getSoloistConfiguration().applyQuality('lossless'); const queuedRejected = assert.rejects(queued, { code: 'CANCELLED' });
  await started; const stopped = value.composition.stopSetup();
  await assert.rejects(value.composition.getSoloistConfiguration().applyQuality('standard'), { code: 'CANCELLED' });
  await tick(); assert.equal(value.owners[0].closes, 0);
  release(); await rejected; await stopped; assert.equal(value.owners[0].closes, 1); assert.equal((await value.composition.publicStatus()).state, 'stopped');
  await queuedRejected; assert.equal(value.calls.filter(call => call === 'quality').length, 1); assert.equal(value.owners.length, 1);
});

test('an in-flight read-only status cannot overwrite the stopped state after logout', async t => {
  let hold = false, release, reached; const started = new Promise(resolve => { reached = resolve; });
  const value = await fixture(t, { freshHook: async () => { if (hold) { reached(); await new Promise(resolve => { release = resolve; }); } } });
  await value.composition.saveKey(KEY); await value.composition.startSetup(); hold = true;
  const status = value.composition.publicStatus(); await started; await value.composition.stopSetup(); release();
  assert.deepEqual(await status, { hasKey: true, state: 'stopped' }); assert.equal(value.owners.length, 1);
});

test('encrypted vault rejects symlinked parent directories before reading or writing a redirected identity', async t => {
  const value = await fixture(t); await value.composition.saveKey(KEY);
  const alias = path.join(value.root, 'redirected'); await fs.symlink(value.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const vault = createSoloistApplianceSecrets({ directory: alias, safeStorage: value.storage });
  await assert.rejects(vault.publicStatus(), { code: 'SECRET_VAULT_INVALID' });
  await assert.rejects(vault.saveKey('spak_' + 'y'.repeat(32)), { code: 'SECRET_VAULT_INVALID' });
  assert.equal((await createSoloistApplianceSecrets({ directory: value.directory, safeStorage: value.storage }).loadForRuntime()).soloistKey, KEY);
  await fs.unlink(alias);
});

test('private runtime permissions fail before any plaintext key, owned process or guest command is created', async t => {
  let checked = 0;
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async (directory, { signal }) => {
    checked++; assert.equal(signal.aborted, false); assert.deepEqual(await fs.readdir(directory), []);
    throw Object.assign(Error('private synthetic SID and path must not escape'), { code: 'PRIVATE_DIRECTORY_PERMISSION_FAILED' });
  } } });
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.startSetup(), error => error.code === 'PRIVATE_DIRECTORY_PERMISSION_FAILED'
    && !error.message.includes('SID') && !error.message.includes(KEY));
  assert.equal(checked, 1); assert.equal(value.owners.length, 0); assert.deepEqual(value.calls, ['download']);
  assert.equal(value.filesystem.some(item => item.operation === 'writeFile' && ['client-key', 'host-key'].includes(path.basename(item.filename))), false);
  assert.equal(value.archives[0].every(byte => byte === 0), true);
  assert.equal((await fs.readdir(value.directory)).some(name => name.startsWith('.appliance-runtime-')), false);
});

test('late private directory permission acknowledgement after stop cannot write keys or start an owner', async t => {
  let reached, release, gateSignal;
  const started = new Promise(resolve => { reached = resolve; });
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async (directory, { signal }) => {
    gateSignal = signal; assert.deepEqual(await fs.readdir(directory), []); reached();
    await new Promise(resolve => { release = resolve; });
  } } });
  await value.composition.saveKey(KEY); const pending = value.composition.startSetup();
  const rejected = assert.rejects(pending, { code: 'CANCELLED' }); await started;
  const stopping = value.composition.stopSetup(); assert.equal(gateSignal.aborted, true); release(); await stopping; await rejected;
  assert.equal(value.owners.length, 0); assert.deepEqual(value.calls, ['download']);
  assert.equal(value.filesystem.some(item => item.operation === 'writeFile' && ['client-key', 'host-key'].includes(path.basename(item.filename))), false);
  assert.equal(value.archives[0].every(byte => byte === 0), true);
  assert.equal((await fs.readdir(value.directory)).some(name => name.startsWith('.appliance-runtime-')), false);
});

test('permission gate observes an empty canonical runtime and is awaited before the first key write', async t => {
  let permissionFinished = false;
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async directory => {
    assert.deepEqual(await fs.readdir(directory), []);
    assert.equal(await fs.realpath(directory), directory);
    await tick(); permissionFinished = true;
  } }, ioOverrides: { async writeFile(filename, ...args) {
    if (['client-key', 'host-key'].includes(path.basename(filename))) assert.equal(permissionFinished, true);
    return fs.writeFile(filename, ...args);
  } } });
  await value.composition.saveKey(KEY); await value.composition.startSetup(); assert.equal(permissionFinished, true);
  assert.equal(value.owners.length, 1);
});

test('a logical runtime alias is accepted only for the same directory identity and all keys use the canonical path', async t => {
  let logical, canonical, gated = false;
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async directory => {
    assert.equal(directory, canonical); assert.deepEqual(await fs.readdir(directory), []); gated = true;
  } }, ioOverrides: {
    async mkdtemp(prefix) { canonical = await fs.mkdtemp(prefix); logical = path.join(path.dirname(canonical), '.appliance-runtime-logical-alias'); return logical; },
    lstat(filename, options) { return fs.lstat(filename === logical ? canonical : filename, options); },
    realpath(filename) { return filename === logical ? Promise.resolve(canonical) : fs.realpath(filename); },
    async writeFile(filename, ...args) { if (['client-key', 'host-key'].includes(path.basename(filename))) {
      assert.equal(gated, true); assert.equal(path.dirname(filename), canonical);
    } return fs.writeFile(filename, ...args); },
  } });
  await value.composition.saveKey(KEY); const channel = await value.composition.getSoloistConfiguration().resolveControlConfiguration();
  assert.notEqual(logical, canonical); assert.equal(path.dirname(channel.keyPath), canonical);
  await value.composition.stopSetup(); await assert.rejects(fs.lstat(canonical), { code: 'ENOENT' });
});

test('a canonical alias with a different inode is rejected before its permission gate or first key write', async t => {
  let logical, canonical, gated = false;
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async () => { gated = true; } }, ioOverrides: {
    async mkdtemp(prefix) { canonical = await fs.mkdtemp(prefix); logical = path.join(path.dirname(canonical), '.appliance-runtime-logical-alias'); return logical; },
    async lstat(filename, options) {
      const value = await fs.lstat(filename === logical ? canonical : filename, options);
      if (filename === canonical && options?.bigint) value.ino += 1n;
      return value;
    },
    realpath(filename) { return filename === logical ? Promise.resolve(canonical) : fs.realpath(filename); },
    rmdir(filename) { return fs.rmdir(filename === logical ? canonical : filename); },
  } });
  await value.composition.saveKey(KEY); await assert.rejects(value.composition.startSetup(), { code: 'PRIVATE_DIRECTORY_CHANGED' });
  assert.equal(gated, false); assert.equal(value.owners.length, 0);
  assert.equal(value.filesystem.some(item => item.operation === 'writeFile' && ['client-key', 'host-key'].includes(path.basename(item.filename))), false);
  await assert.rejects(fs.lstat(canonical), { code: 'ENOENT' });
});

test('runtime cleanup refuses a substituted directory identity rather than deleting the replacement', async t => {
  let replaced = false, runtimeDirectory;
  const value = await fixture(t, { changes: { secureRuntimeDirectory: async directory => { runtimeDirectory = directory; } },
    ioOverrides: { async lstat(filename, options) {
      const value = await fs.lstat(filename, options);
      if (replaced && filename === runtimeDirectory && options?.bigint) value.ino += 1n;
      return value;
    } } });
  await value.composition.saveKey(KEY); await value.composition.startSetup(); replaced = true;
  await assert.rejects(value.composition.stopSetup(), { code: 'RUNTIME_IDENTITY_CLEANUP_FAILED' });
  assert.equal(value.filesystem.some(item => item.operation === 'rmdir' && item.filename === runtimeDirectory), false);
  assert.deepEqual(await fs.readdir(runtimeDirectory), []);
});

test('fixed guest runner classifies empty failed stderr once while retaining strict stdout validation and redaction', async () => {
  const channel = { sshExecutablePath: 'C:\\public\\ssh.exe', keyPath: 'C:\\private\\key', knownHostsPath: 'C:\\private\\known', sshPort: 51101 };
  const fixtures = [
    ['client-key', 'WARNING: UNPROTECTED PRIVATE KEY FILE!\nPermissions for SECRET_PATH are too open.\n', 'SSH_CLIENT_KEY_PERMISSIONS'],
    ['host-key', 'Host key verification failed.\n', 'SSH_HOST_KEY_REJECTED'],
    ['auth', 'folia@127.0.0.1: Permission denied (publickey).\n', 'SSH_AUTHENTICATION_FAILED'],
  ];
  for (const [, stderr, code] of fixtures) {
    let spawned = 0;
    const runner = createGuestRunner({ spawnProcess: () => {
      spawned++; const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      child.stdin.end = () => setImmediate(() => { child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', 255); }); return child;
    } });
    await assert.rejects(runner({ channel, operation: 'credentials', input: { soloistKey: KEY, maPassword: 'a'.repeat(32) } }),
      error => error.code === code && !error.message.includes('SECRET_PATH') && !error.message.includes(KEY));
    assert.equal(spawned, 1);
  }
  const invalid = createGuestRunner({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin.end = () => setImmediate(() => { child.stdout.emit('data', Buffer.from('SECRET_INVALID_STDOUT'));
      child.stderr.emit('data', Buffer.from('Host key verification failed.\n')); child.emit('close', 255); }); return child;
  } });
  await assert.rejects(invalid({ channel, operation: 'ports' }), error => error.code === 'GUEST_PROTOCOL_INVALID'
    && !error.message.includes('SECRET_INVALID_STDOUT'));
});

test('read-only ports retries a connection refusal while credential mutations never retry', async t => {
  const seen = new Map();
  const ports = createGuestRunner({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin.end = () => setImmediate(() => {
      if (seen.get('ports') === 1) { child.stderr.emit('data', Buffer.from('ssh: connect to host 127.0.0.1 port 51101: Connection refused\n')); child.emit('close', 255); }
      else child.emit('close', 0);
    }); return child;
  } });
  const value = await fixture(t, { command: async request => {
    const attempts = (seen.get(request.operation) || 0) + 1; seen.set(request.operation, attempts);
    if (request.operation === 'ports') {
      return ports(request);
    }
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') throw Object.assign(Error('safe synthetic timeout'), { code: 'SSH_CONNECTION_TIMEOUT' });
    throw Error('no later command is allowed');
  } });
  await value.composition.saveKey(KEY); await assert.rejects(value.composition.startSetup(), { code: 'SSH_CONNECTION_TIMEOUT' });
  assert.equal(seen.get('ports'), 2); assert.equal(seen.get('install'), 1); assert.equal(seen.get('credentials'), 1);
  assert.equal(value.owners[0].closes, 1); assert.equal(value.discoveries.length, 0);
});

test('host-key or client-key rejection at ports fails immediately and never installs or injects credentials', async t => {
  for (const code of ['SSH_HOST_KEY_REJECTED', 'SSH_CLIENT_KEY_PERMISSIONS', 'SSH_AUTHENTICATION_FAILED']) {
    const value = await fixture(t, { command: async () => { throw Object.assign(Error('safe synthetic failure'), { code }); } });
    await value.composition.saveKey(KEY); await assert.rejects(value.composition.startSetup(), { code });
    assert.deepEqual(value.calls, ['download', 'owner', 'ports']); assert.equal(value.owners[0].closes, 1);
  }
});

test('quality mutation connection failures are surfaced once and never retried as readiness', async t => {
  const value = await fixture(t, { command: async request => {
    if (request.operation === 'ports') return { portsReady: true };
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    if (request.operation === 'status') return { credentialsReady: true, maReady: true, receiverReady: true, stage: 'ready' };
    if (request.operation === 'quality') throw Object.assign(Error('safe synthetic refused'), { code: 'SSH_CONNECTION_REFUSED' });
  } });
  await value.composition.saveKey(KEY); await value.composition.startSetup(); value.pair();
  await assert.rejects(value.composition.getSoloistConfiguration().applyQuality('high'), { code: 'SSH_CONNECTION_REFUSED' });
  assert.equal(value.calls.filter(operation => operation === 'quality').length, 1);
});

const startupDiagnosticsSample = () => ({ schema: 1, units: ['folia-credentials-ready.path', 'folia-runtime.target',
  'folia-music-assistant.service', 'folia-sendspin-bootstrap.service', 'folia-sendspin.service',
  'folia-spotify-bootstrap.service', 'folia-pairing-relay.service'].map(unit => ({ unit, available: true,
    loadState: 'loaded', activeState: unit === 'folia-music-assistant.service' ? 'failed' : 'inactive',
    subState: unit === 'folia-music-assistant.service' ? 'failed' : 'dead', result: 'exit-code',
    exitCode: unit === 'folia-music-assistant.service' ? 1 : 0, termination: 'exited', hasMainProcess: false,
    restarts: unit === 'folia-music-assistant.service' ? 2 : 0, conditionPassed: true, assertPassed: true })) });
function startupTimeoutFixture(t, observeDiagnostics, changes = {}) {
  let time = 0;
  return fixture(t, { changes: { readinessTimeoutMs: 100, now: () => time += 1000, ...changes }, command: async request => {
    if (request.operation === 'ports') return { portsReady: true };
    if (request.operation === 'install') return { installed: true, archiveSha256: request.input.archiveSha256, executableSha256: request.input.executableSha256 };
    if (request.operation === 'credentials') return { credentialsReady: true };
    if (request.operation === 'status') return { credentialsReady: true, maReady: false, receiverReady: false, stage: 'music-assistant-starting' };
    if (request.operation === 'startupDiagnostics') return observeDiagnostics(request);
    throw Error('a startup timeout cannot dispatch later playback or quality commands');
  } });
}

test('MA startup timeout reads safe diagnostics on the same lease before failure publication and owned cleanup', async t => {
  let value, statusChannel, failure; const events = [], input = startupDiagnosticsSample();
  value = await startupTimeoutFixture(t, async request => {
    assert.deepEqual(request.input, {}); assert.equal(request.timeoutMs, 20000); assert.equal(request.signal.aborted, false);
    assert.equal(value.owners[0].state, 'running'); assert.equal(value.owners[0].closes, 0);
    statusChannel = request.channel; assert.equal((await value.composition.publicStatus()).state, 'starting'); return input;
  });
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.startSetup({ onProgress: event => events.push(event) }), error => {
    failure = error; return error.code === 'APPLIANCE_RUNTIME_TIMEOUT' && error.diagnostics.units[2].exitCode === 1;
  });
  const observation = events.find(event => event.stage === 'startup-diagnostics');
  assert.equal(observation.diagnostics, failure.diagnostics); assert.equal(Object.isFrozen(failure.diagnostics.units[2]), true);
  assert.equal(Object.keys(failure).includes('diagnostics'), false); input.units[2].exitCode = 99;
  assert.equal(failure.diagnostics.units[2].exitCode, 1);
  assert.equal(statusChannel.appliancePid, value.owners[0].lease.pid); assert.equal(statusChannel.sshPort, value.owners[0].lease.ports.ssh);
  assert.deepEqual(value.calls, ['download', 'owner', 'ports', 'install', 'credentials', 'status', 'startupDiagnostics']);
  assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'failed', code: 'APPLIANCE_RUNTIME_TIMEOUT' });
  assert.equal(value.owners[0].closes, 1); assert.equal(value.discoveries.length, 0);
  assert.equal((await fs.readdir(value.directory)).some(name => name.startsWith('.appliance-runtime-')), false);
});

test('malformed or failed startup diagnostics never replace the original timeout or publish private payloads', async t => {
  for (const kind of ['private-field', 'transport-rejection']) {
    const events = [];
    const value = await startupTimeoutFixture(t, () => {
      if (kind === 'transport-rejection') throw Object.assign(Error('SECRET_PATH and private account'), { code: 'SSH_HOST_KEY_REJECTED' });
      const result = startupDiagnosticsSample(); result.units[2].raw = 'SECRET_PATH and private account'; return result;
    });
    await value.composition.saveKey(KEY);
    await assert.rejects(value.composition.startSetup({ onProgress: event => events.push(event) }), error =>
      error.code === 'APPLIANCE_RUNTIME_TIMEOUT' && !Object.hasOwn(error, 'diagnostics') && !error.message.includes('SECRET_PATH'));
    assert.equal(events.some(event => event.stage === 'startup-diagnostics'), false);
    assert.equal(JSON.stringify(events).includes('SECRET_PATH'), false);
    assert.equal(value.calls.filter(operation => operation === 'startupDiagnostics').length, 1);
    assert.equal(value.calls.filter(operation => operation === 'credentials').length, 1);
    assert.equal(value.calls.filter(operation => operation === 'install').length, 1);
    assert.equal(value.owners[0].closes, 1);
  }
});

test('unrelated preparation errors and absent live owners do not trigger startup diagnostics', async t => {
  const failed = await fixture(t, { command: async () => { throw Object.assign(Error('fixture credential failure'), { code: 'SSH_AUTHENTICATION_FAILED' }); } });
  await failed.composition.saveKey(KEY); await assert.rejects(failed.composition.startSetup(), { code: 'SSH_AUTHENTICATION_FAILED' });
  assert.equal(failed.calls.includes('startupDiagnostics'), false);
  let value;
  value = await startupTimeoutFixture(t, () => { throw Error('diagnostic must not run after owner replacement'); });
  const start = value.owners;
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.startSetup({ onProgress: event => {
    if (event.stage === 'music-assistant-starting' && start.length) start[0].state = 'closed';
  } }), { code: 'APPLIANCE_CHANGED' });
  assert.equal(value.calls.includes('startupDiagnostics'), false);
});

test('stop aborts pending readonly diagnostics promptly and ignores late evidence without changing the stopped state', async t => {
  let reached, release, signal; const began = new Promise(resolve => { reached = resolve; }), events = [];
  const value = await startupTimeoutFixture(t, request => {
    signal = request.signal; reached(); return new Promise(resolve => { release = resolve; });
  });
  await value.composition.saveKey(KEY);
  const pending = value.composition.startSetup({ onProgress: event => events.push(event) });
  const failed = assert.rejects(pending, error => error.code === 'APPLIANCE_RUNTIME_TIMEOUT' && !Object.hasOwn(error, 'diagnostics'));
  await began; await value.composition.stopSetup(); await failed;
  assert.equal(signal.aborted, true); assert.equal(value.owners[0].closes, 1);
  release(startupDiagnosticsSample()); await tick();
  assert.equal(events.some(event => event.stage === 'startup-diagnostics'), false);
  assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'stopped' });
  assert.equal((await fs.readdir(value.directory)).some(name => name.startsWith('.appliance-runtime-')), false);
});

test('a nonsettling diagnostic runner is bounded to twenty seconds and cannot postpone owned cleanup indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reached, signal, settled = false; const began = new Promise(resolve => { reached = resolve; });
  const value = await startupTimeoutFixture(t, request => {
    signal = request.signal; assert.equal(request.timeoutMs, 20000); reached(); return new Promise(() => {});
  });
  await value.composition.saveKey(KEY); const pending = value.composition.startSetup();
  const failed = assert.rejects(pending, error => {
    settled = true; return error.code === 'APPLIANCE_RUNTIME_TIMEOUT' && !Object.hasOwn(error, 'diagnostics');
  });
  await began; t.mock.timers.tick(19999); await tick();
  assert.equal(settled, false); assert.equal(signal.aborted, false); assert.equal(value.owners[0].closes, 0);
  t.mock.timers.tick(1); await failed;
  assert.equal(signal.aborted, true); assert.equal(value.owners[0].closes, 1);
  assert.deepEqual(await value.composition.publicStatus(), { hasKey: true, state: 'failed', code: 'APPLIANCE_RUNTIME_TIMEOUT' });
});

test('diagnostics received after the owner lease changes are discarded while retaining the original timeout', async t => {
  let value; const events = [];
  value = await startupTimeoutFixture(t, () => {
    value.owners[0].lease.ports.ssh++; return startupDiagnosticsSample();
  });
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.startSetup({ onProgress: event => events.push(event) }), error =>
    error.code === 'APPLIANCE_RUNTIME_TIMEOUT' && !Object.hasOwn(error, 'diagnostics'));
  assert.equal(events.some(event => event.stage === 'startup-diagnostics'), false); assert.equal(value.owners[0].closes, 1);
});

test('fixed startup operation accepts only an empty request and projects its bounded enum response', async () => {
  const channel = { sshExecutablePath: 'C:\\public\\ssh.exe', keyPath: 'C:\\private\\key', knownHostsPath: 'C:\\private\\known', sshPort: 51101 };
  let spawned = 0, body;
  const runner = createGuestRunner({ spawnProcess: (file, args, options) => {
    spawned++; assert.equal(file, channel.sshExecutablePath); assert.equal(args.at(-1), soloistStartupDiagnosticsCommand);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    child.stdin.end = bytes => { body = bytes; assert.equal(bytes.toString(), '{}'); setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result: startupDiagnosticsSample() }))); child.emit('close', 0);
    }); }; return child;
  } });
  assert.throws(() => runner({ channel, operation: 'startupDiagnostics', input: { unit: 'foreign.service' } }), { code: 'INVALID_REQUEST' });
  assert.equal(spawned, 0);
  const value = await runner({ channel, operation: 'startupDiagnostics' });
  assert.equal(value.units[2].exitCode, 1); assert.equal(Object.isFrozen(value.units[2]), true); assert.equal(body.every(byte => byte === 0), true);
});

test('fixed startup operation rejects private response fields and terminates its owned reader on timeout or cancellation', async () => {
  const channel = { sshExecutablePath: 'C:\\public\\ssh.exe', keyPath: 'C:\\private\\key', knownHostsPath: 'C:\\private\\known', sshPort: 51101 };
  let kills = 0;
  const malformed = createGuestRunner({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { kills++; };
    child.stdin.end = () => setImmediate(() => {
      const result = startupDiagnosticsSample(); result.units[2].stderr = 'SECRET';
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result }))); child.emit('close', 0);
    }); return child;
  } });
  await assert.rejects(malformed({ channel, operation: 'startupDiagnostics' }), error =>
    error.code === 'GUEST_PROTOCOL_INVALID' && !error.message.includes('SECRET'));
  const hanging = createGuestRunner({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { kills++; };
    child.stdin.end = () => {}; return child;
  } });
  await assert.rejects(hanging({ channel, operation: 'startupDiagnostics', timeoutMs: 10 }), { code: 'GUEST_CONTROL_TIMEOUT' });
  const abort = new AbortController(); const pending = hanging({ channel, operation: 'startupDiagnostics', signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'CANCELLED' }); abort.abort(); await rejected; assert.equal(kills, 3);
});
