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
    return { async getChannel({ signal } = {}) { if (signal?.aborted) throw Object.assign(Error('cancelled'), { code: 'CANCELLED' });
        if (options.channelHook) await options.channelHook({ owner, signal }); return channel; },
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

// Full composition plus real discovery logic; transport and guest operations are inert.
const { createSoloistDiscovery } = require('../../electron/spotify/soloistDiscovery.cjs');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { projectEvent, SOURCE_FILES } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const DEVICE = 'owned-fixture';
const readySnapshot = (deviceID = DEVICE) => ({ receivedAt: Date.now(), zeroConf: { deviceID },
  authState: { logged_in: false, is_active: false } });
const starting = () => Object.assign(Error('synthetic secret must never escape'), { code: 'SOLOIST_STARTING' });
const noNetwork = counters => Object.fromEntries(['requestHttp', 'networkInterfaces', 'createServer', 'createMdns'].map(name =>
  [name, () => { counters[name]++; throw Error(`Unexpected synthetic ${name}`); }]));
const zeroCounters = () => ({ requestHttp: 0, networkInterfaces: 0, createServer: 0, createMdns: 0 });

function fakeNetwork(counters) {
  return {
    requestHttp(_options, receive) {
      counters.requestHttp++;
      const outgoing = new EventEmitter(); outgoing.destroy = () => {};
      outgoing.end = () => setImmediate(() => {
        const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.headers = {}; incoming.destroy = () => {};
        receive(incoming);
        incoming.emit('data', Buffer.from(JSON.stringify({ deviceID: DEVICE, remoteName: 'Folia Spotify', status: 101, spotifyError: 0 })));
        incoming.emit('end');
      });
      return outgoing;
    },
    networkInterfaces() { counters.networkInterfaces++; return { synthetic: [{ family: 'IPv4', internal: false, address: '192.0.2.14' }] }; },
    createServer() {
      counters.createServer++;
      const server = new EventEmitter();
      server.listen = () => setImmediate(() => server.emit('listening'));
      server.address = () => ({ port: 51200 }); server.close = callback => setImmediate(callback);
      return server;
    },
    createMdns() {
      counters.createMdns++;
      const mdns = new EventEmitter(); mdns.respond = (_packet, callback) => setImmediate(callback);
      mdns.destroy = callback => setImmediate(callback);
      setImmediate(() => mdns.emit('ready'));
      return mdns;
    },
  };
}

function standalone(t, { readFresh, getChannel, timeoutMs = 1000, observe, network } = {}) {
  const counters = zeroCounters(), events = [];
  const channel = { soloistPort: 51104, appliancePid: 500, applianceStartedAt: '2026-10-07T05:21:18.606Z' };
  const discovery = createSoloistDiscovery({ getChannel: getChannel || (async () => ({ ...channel })), readFresh,
    deviceName: 'Folia Spotify', ...(network ? fakeNetwork(counters) : noNetwork(counters)), timeoutMs,
    observe: event => { events.push(event); observe?.(event); } });
  t.after(() => discovery.close());
  return { discovery, counters, events, channel };
}

for (const failedRead of [2, 3]) {
  test(`recovery from pipeline read ${failedRead} starts discovery once without replaying setup mutations`, async t => {
    let reads = 0;
    const counters = zeroCounters(), events = [], recorded = [];
    t.after(installPreviewDiagnosticSink({ enabled: () => true, record: (type, fields) => { recorded.push({ type, fields }); return true; } }));
    const value = await fixture(t, {
      freshHook: async () => { if (++reads === failedRead) throw starting(); },
      changes: { createDiscovery: options => createSoloistDiscovery({ ...options, ...fakeNetwork(counters),
        observe: event => { events.push(event); options.observe(event); }, timeoutMs: 1000 }) },
    });
    await value.composition.saveKey(KEY);
    assert.deepEqual(await value.composition.startSetup(), { hasKey: true, state: 'pairing-required' });
    assert.equal(reads, 5, 'initial, two discovery proofs, one retry, final public status');
    assert.deepEqual(counters, { requestHttp: 1, networkInterfaces: 1, createServer: 1, createMdns: 1 });
    assert.equal(value.owners[0].starts, 1); assert.equal(value.owners[0].closes, 0);
    for (const operation of ['ports', 'install', 'credentials', 'status'])
      assert.equal(value.calls.filter(call => call === operation).length, 1);
    assert.deepEqual(events.filter(event => event.event === 'discovery-retry'), [{ event: 'discovery-retry',
      phase: 'retry', stage: failedRead === 2 ? 'owned-snapshot' : 'owned-recheck', errorCode: 'SOLOIST_STARTING', attempt: 1 }]);
    assert.deepEqual(recorded, [
      { type: 'spotify.discovery', fields: { phase: 'retry', stage: failedRead === 2 ? 'owned-snapshot' : 'owned-recheck', errorCode: 'SOLOIST_STARTING', attempt: 1 } },
      { type: 'spotify.discovery', fields: { phase: 'result', stage: 'ready', ok: true } },
    ]);
    assert.equal(JSON.stringify(events).includes('secret'), false);
  });
}

test('a persistent readiness gap expires within the original deadline and retains its cause', async t => {
  let reads = 0;
  const value = standalone(t, { timeoutMs: 75, readFresh: async () => ++reads === 1 ? readySnapshot() : Promise.reject(starting()) });
  const begin = Date.now();
  await assert.rejects(value.discovery.start(), { code: 'SOLOIST_START_TIMEOUT' });
  assert.ok(Date.now() - begin < 500, 'retry must not start a fresh deadline');
  assert.equal(reads, 2); assert.deepEqual(value.counters, zeroCounters());
  assert.deepEqual(value.events.find(event => event.event === 'discovery-failed'), {
    event: 'discovery-failed', phase: 'result', stage: 'owned-recheck', ok: false, errorCode: 'SOLOIST_START_TIMEOUT', causeCode: 'SOLOIST_STARTING', attempt: 1,
  });
});

test('user cancellation aborts the retry wait promptly and stays CANCELLED', async t => {
  let reads = 0; const control = new AbortController();
  const value = standalone(t, { readFresh: async () => ++reads === 1 ? readySnapshot() : Promise.reject(starting()),
    observe: event => { if (event.event === 'discovery-retry') control.abort(); } });
  const begin = Date.now();
  await assert.rejects(value.discovery.start({ signal: control.signal }), { code: 'CANCELLED' });
  assert.ok(Date.now() - begin < 200); assert.equal(reads, 2); assert.deepEqual(value.counters, zeroCounters());
  assert.equal(value.events.find(event => event.event === 'discovery-failed').errorCode, 'CANCELLED');
});

test('a replaced appliance lease during retry fails before another owned read or network operation', async t => {
  let reads = 0, channels = 0;
  const value = standalone(t, {
    readFresh: async () => ++reads === 1 ? readySnapshot() : Promise.reject(starting()),
    getChannel: async () => ({ soloistPort: 51104, appliancePid: ++channels >= 3 ? 501 : 500,
      applianceStartedAt: '2026-10-07T05:21:18.606Z' }),
  });
  await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_IDENTITY_CHANGED' });
  assert.equal(reads, 2); assert.equal(channels, 3); assert.deepEqual(value.counters, zeroCounters());
});

for (const invalid of ['changed-device', 'stale-snapshot']) {
  test(`a recovered listener with ${invalid} cannot weaken the pinned proof`, async t => {
    let reads = 0;
    const value = standalone(t, { readFresh: async () => {
      reads++;
      if (reads === 2) throw starting();
      return reads === 1 ? readySnapshot() : invalid === 'changed-device' ? readySnapshot('replacement')
        : { ...readySnapshot(), receivedAt: Date.now() - 6000 };
    } });
    await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_IDENTITY_CHANGED' });
    assert.equal(reads, 3); assert.deepEqual(value.counters, zeroCounters());
  });
}

for (const code of ['OWNER_CHANGED', 'AUTH_SCHEMA_INVALID', 'OWNED_PROTOCOL_INVALID', 'APPLIANCE_CHANGED', 'ZC_CONTROL_UNAVAILABLE']) {
  test(`${code} is retained diagnostically and is never retried`, async t => {
    let reads = 0;
    const value = standalone(t, { readFresh: async () => {
      if (++reads === 2) throw Object.assign(Error('synthetic private path and token'), { code });
      return readySnapshot();
    } });
    await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_UNAVAILABLE' });
    assert.equal(reads, 2); assert.deepEqual(value.counters, zeroCounters());
    const failure = value.events.find(event => event.event === 'discovery-failed');
    assert.equal(failure.causeCode, code); assert.equal(failure.stage, 'owned-recheck');
    assert.equal(value.events.some(event => event.event === 'discovery-retry'), false);
    assert.equal(JSON.stringify(value.events).includes('private'), false);
  });
}

test('an unrecognized failure code and exception message are not copied into diagnostics', async t => {
  const value = standalone(t, { readFresh: async () => { throw Object.assign(Error('secret account data'), { code: 'secret account data' }); } });
  await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_UNAVAILABLE' });
  assert.equal(value.events.find(event => event.event === 'discovery-failed').causeCode, 'UNKNOWN');
  assert.equal(JSON.stringify(value.events).includes('secret'), false);
});

test('composition publishes exact failed stage and safe original cause through the private bus', async t => {
  let reads = 0; const recorded = [], counters = zeroCounters();
  t.after(installPreviewDiagnosticSink({ enabled: () => true, record: (type, fields) => { recorded.push({ type, fields }); return true; } }));
  const value = await fixture(t, {
    freshHook: async () => { if (++reads === 3) throw Object.assign(Error('private account and path'), { code: 'OWNER_CHANGED' }); },
    changes: { createDiscovery: options => createSoloistDiscovery({ ...options, ...noNetwork(counters), timeoutMs: 1000 }) },
  });
  await value.composition.saveKey(KEY);
  await assert.rejects(value.composition.startSetup(), { code: 'DISCOVERY_UNAVAILABLE' });
  assert.deepEqual(recorded, [{ type: 'spotify.discovery', fields: {
    phase: 'result', stage: 'owned-recheck', ok: false, errorCode: 'DISCOVERY_UNAVAILABLE', causeCode: 'OWNER_CHANGED', attempt: 1,
  } }]);
  assert.deepEqual(counters, zeroCounters());
});

for (const loss of ['stopped', 'replaced']) {
  test(`a ${loss} owner during readiness retry cannot re-enter owned.getChannel or relaunch the appliance`, async t => {
    let reads = 0, channels = 0, value;
    const counters = zeroCounters(), events = [];
    value = await fixture(t, {
      freshHook: async () => { if (++reads === 3) throw starting(); },
      channelHook: async ({ owner }) => { channels++; if (owner.state !== 'running') await owner.start(); },
      changes: { createDiscovery: options => createSoloistDiscovery({ ...options, ...noNetwork(counters), timeoutMs: 1000,
        observe: event => {
          events.push(event); options.observe(event);
          if (event.event === 'discovery-retry') {
            if (loss === 'stopped') value.owners[0].state = 'stopped';
            else value.owners[0].lease.pid++;
          }
        } }) },
    });
    await value.composition.saveKey(KEY);
    await assert.rejects(value.composition.startSetup(), { code: 'DISCOVERY_UNAVAILABLE' });
    assert.equal(channels, 3, 'composition channel, initial discovery channel, first trusted check only');
    assert.equal(reads, 3); assert.equal(value.owners[0].starts, 1); assert.deepEqual(counters, zeroCounters());
    assert.equal(events.find(event => event.event === 'discovery-failed').causeCode, 'APPLIANCE_CHANGED');
  });
}

test('a channel result received after owner loss is rejected before another owned read', async t => {
  let channels = 0, release, entered;
  const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const counters = zeroCounters();
  const value = await fixture(t, {
    channelHook: async () => { if (++channels === 2) { entered(); await held; } },
    changes: { createDiscovery: options => createSoloistDiscovery({ ...options, ...noNetwork(counters), timeoutMs: 1000 }) },
  });
  await value.composition.saveKey(KEY);
  const pending = value.composition.startSetup(); await reached;
  value.owners[0].state = 'stopped'; release();
  await assert.rejects(pending, { code: 'DISCOVERY_UNAVAILABLE' });
  assert.equal(value.calls.filter(call => call === 'fresh').length, 1);
  assert.equal(value.owners[0].starts, 1); assert.deepEqual(counters, zeroCounters());
});

test('discovery schema requires fixed stage/phase and excludes identities, addresses, unknown values and getters', () => {
  const fields = { phase: 'result', stage: 'owned-recheck', ok: false, errorCode: 'DISCOVERY_UNAVAILABLE',
    causeCode: 'SOLOIST_STARTING', attempt: 2, deviceID: 'secret-device', interfaces: ['192.0.2.14'],
    publicKey: 'secret-public-key', account: 'private-account', message: 'private-path', body: 'secret-payload' };
  assert.deepEqual(projectEvent('spotify.discovery', fields), { type: 'spotify.discovery', fields: {
    phase: 'result', stage: 'owned-recheck', ok: false, errorCode: 'DISCOVERY_UNAVAILABLE', causeCode: 'SOLOIST_STARTING', attempt: 2,
  } });
  assert.equal(projectEvent('spotify.discovery', { phase: 'result' }), null);
  assert.equal(projectEvent('spotify.discovery', { stage: 'owned-recheck' }), null);
  assert.equal(projectEvent('spotify.discovery', { phase: 'result', stage: 'private-path' }), null);
  let getterCalls = 0;
  const untrusted = { phase: 'result', stage: 'owned-recheck', attempt: 129, errorCode: 'private-token' };
  Object.defineProperty(untrusted, 'causeCode', { get() { getterCalls++; return 'SOLOIST_STARTING'; } });
  assert.deepEqual(projectEvent('spotify.discovery', untrusted), { type: 'spotify.discovery', fields: { phase: 'result', stage: 'owned-recheck' } });
  assert.equal(getterCalls, 0);
  assert.ok(SOURCE_FILES.includes('electron/spotify/soloistDiscovery.cjs'));
});
