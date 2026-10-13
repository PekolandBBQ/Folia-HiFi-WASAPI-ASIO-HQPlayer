const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createSoloistDiscovery } = require('../../electron/spotify/soloistDiscovery.cjs');

// Isolated real HTTP sockets and synthetic mDNS publication only. No appliance,
// SSH, official client, account, UDP service or paired private disk is touched.
const DEVICE = 'synthetic-sdk-device', NAME = 'Folia Synthetic Receiver';
const LAN = { ethernet: [{ family: 'IPv4', internal: false, address: '192.0.2.14' }],
  wifi: [{ family: 'IPv4', internal: false, address: '198.51.100.22' }],
  loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  v6: [{ family: 'IPv6', internal: false, address: '2001:db8::1' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const info = () => ({ deviceID: DEVICE, remoteName: NAME, status: 101, spotifyError: 0,
  publicKey: 'public-fixture', activeUser: '' });
function call(port, target, { method = 'GET', body = '', headers = {}, localAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: target, method, localAddress,
      headers: { 'content-length': Buffer.byteLength(body), ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, agent: false }, response => {
      const bytes = []; response.on('data', chunk => bytes.push(chunk));
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(bytes).toString(), headers: response.headers }));
    }); request.on('error', reject); request.end(body);
  });
}
async function fixture(t, options = {}) {
  const received = [], advertisements = [], diagnostics = [], channels = []; let freshCalls = 0, getCalls = 0;
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); received.push({ target: request.url, method: request.method, body, headers: request.headers });
    if (options.handle && await options.handle(request, response, body, received.length) === true) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.method === 'POST' ? { status: 101, spotifyError: 0 } : options.info || info()));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const lease = { soloistPort: upstream.address().port, appliancePid: 718, applianceStartedAt: '2026-10-03T12:00:00.123Z' };
  const getChannel = async ({ signal } = {}) => {
    getCalls++; channels.push({ signal }); return options.getChannel ? options.getChannel(lease, getCalls, signal) : { ...lease };
  };
  const readFresh = async ({ signal } = {}) => {
    freshCalls++; return options.readFresh ? options.readFresh(freshCalls, signal)
      : { receivedAt: Date.now(), zeroConf: { deviceID: DEVICE }, readiness: 'pairing-required', authState: { logged_in: false, is_active: false },
        playback: { status: null, uri: null, durationMs: null, positionMs: null, speed: null } };
  };
  const mdnsInstances = [];
  const createMdns = flags => {
    const value = new EventEmitter(); value.options = flags; value.destroyed = false;
    value.respond = (packet, cb) => { advertisements.push({ packet, interface: flags.interface }); setImmediate(() => cb(options.publishError)); };
    value.destroy = cb => { value.destroyed = true; setImmediate(cb); };
    mdnsInstances.push(value);
    if (!options.holdMdns) setImmediate(() => {
      if (options.mdnsWarning) value.emit('warning', Object.assign(Error('private NIC name'), { code: 'EADDRNOTAVAIL' }));
      else value.emit(options.mdnsError ? 'error' : 'ready', Error('secret path must not escape'));
    });
    return value;
  };
  const discovery = createSoloistDiscovery({ getChannel, readFresh, deviceName: NAME, networkInterfaces: () => options.interfaces || LAN,
    createMdns, observe: value => { diagnostics.push(value); if (options.observeThrows) throw Error('private observer failure'); },
    timeoutMs: options.timeoutMs || 1000, maximumBodyBytes: options.maximumBodyBytes || 65536 });
  t.after(async () => { await discovery.close(); await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }); });
  return { discovery, received, advertisements, diagnostics, mdnsInstances, lease, counts: () => ({ freshCalls, getCalls }), channels };
}

test('construction is inert; explicit start validates owned lease and fresh ZC identity before LAN announcement', async t => {
  const value = await fixture(t); assert.deepEqual(value.counts(), { freshCalls: 0, getCalls: 0 });
  assert.equal(value.received.length, 0); assert.equal(value.mdnsInstances.length, 0);
  const state = await value.discovery.start(); assert.equal(state.sameHostOnly, true); assert.equal(state.deviceName, NAME);
  assert.deepEqual(state.interfaces, ['192.0.2.14', '198.51.100.22']); assert.ok(Object.isFrozen(state.interfaces));
  assert.equal(value.received.length, 1); assert.equal(value.received[0].target, '/zc?action=getInfo');
  assert.equal(value.received[0].headers.host, `127.0.0.1:${value.lease.soloistPort}`);
  assert.deepEqual(value.mdnsInstances.map(item => item.options.interface), state.interfaces);
  for (const item of value.mdnsInstances) assert.deepEqual(item.options, { interface: item.options.interface, bind: '0.0.0.0', type: 'udp4', reuseAddr: true, loopback: true, ttl: 255 });
  const packet = value.advertisements[0].packet;
  assert.ok(packet.answers.some(record => record.name === '_spotify-connect._tcp.local' && record.type === 'PTR'));
  assert.deepEqual(packet.answers.find(record => record.type === 'TXT').data.map(bytes => bytes.toString()), ['CPath=/zc', 'VERSION=1.0', 'Stack=SP']);
  assert.equal(packet.answers.find(record => record.type === 'SRV').data.port, state.port);
  assert.deepEqual(packet.answers.filter(record => record.type === 'A').map(record => record.data), state.interfaces);
  assert.equal(JSON.stringify(packet).includes(DEVICE), false, 'DNS instance name derives from a hash, not an unescaped SDK identifier');
  assert.deepEqual(value.discovery.status(), { available: true, closed: false });
});

test('brand-new unauthenticated receiver advertises with no track, playback state or active session', async t => {
  let reads = 0;
  const value = await fixture(t, { readFresh: () => {
    reads++;
    return { receivedAt: Date.now(), zeroConf: { deviceID: DEVICE }, readiness: 'pairing-required',
      authState: { logged_in: false, is_active: false },
      playback: { status: null, uri: null, durationMs: null, positionMs: null, speed: null } };
  } });
  const state = await value.discovery.start(); assert.equal(state.available, true); assert.ok(reads >= 2);
  const result = await call(state.port, '/zc?action=getInfo'); assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).deviceID, DEVICE);
  assert.ok(value.advertisements.some(value => value.packet.answers.some(record => record.type === 'SRV')));
  assert.deepEqual(value.received.map(value => value.target), ['/zc?action=getInfo', '/zc?action=getInfo']);
});

test('concurrent starts share one bridge; normal same-host getInfo and addUser forward only fixed loopback ZC', async t => {
  const value = await fixture(t, { observeThrows: true });
  const [state, duplicate] = await Promise.all([value.discovery.start(), value.discovery.start()]); assert.equal(state, duplicate);
  const result = await call(state.port, '/zc?action=getInfo&version=2.10.0'); assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), info());
  const body = 'action=addUser&userName=sensitive-user&blob=sensitive-blob&clientKey=sensitive-key';
  const paired = await call(state.port, '/zc', { method: 'POST', body, headers: { authorization: 'private-header', cookie: 'private-cookie', 'x-forwarded-for': 'remote' } });
  assert.equal(paired.status, 200); assert.equal(JSON.parse(paired.body).status, 101);
  const forwarded = value.received.at(-1); assert.equal(forwarded.body, body); assert.equal(forwarded.target, '/zc');
  assert.equal(forwarded.headers.authorization, undefined); assert.equal(forwarded.headers.cookie, undefined); assert.equal(forwarded.headers['x-forwarded-for'], undefined);
  assert.equal(paired.headers['cache-control'], 'no-store'); assert.equal(paired.headers['access-control-allow-origin'], undefined);
  const safe = JSON.stringify(value.diagnostics); assert.ok(!/sensitive|private-header|private-cookie|public-fixture/.test(safe));
});

test('anonymous getInfo uses the startup-proved relay without repeated host ownership reads and still rejects changed device identity', async t => {
  let changed = false;
  const value = await fixture(t, {
    readFresh: count => {
      if (count > 2) throw Error('unexpected repeated host ownership read');
      return { receivedAt: Date.now(), zeroConf: { deviceID: DEVICE } };
    },
    handle: (_request, response, _body, count) => {
      if (count > 1 && changed) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...info(), deviceID: 'replacement-device' }));
        return true;
      }
      return false;
    },
  });
  const state = await value.discovery.start(), baseline = value.counts();
  const response = await call(state.port, '/zc?action=getInfo&version=2.10.0');
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), info());
  assert.deepEqual(value.counts(), baseline);
  assert.equal(value.received.at(-1).headers.host, `127.0.0.1:${value.lease.soloistPort}`);
  changed = true;
  const replacement = await call(state.port, '/zc?action=getInfo').catch(error => ({ disconnected: error.code }));
  assert.ok(replacement.status === 502 || replacement.disconnected === 'ECONNRESET');
  await value.discovery.close();
  assert.deepEqual(value.counts(), baseline); assert.equal(value.discovery.status().available, false);
});

test('pairing POST checks the current lease before and after forwarding without repeated host ownership reads', async t => {
  const value = await fixture(t, { readFresh: count => {
    if (count > 2) throw Error('unexpected repeated host ownership read');
    return { receivedAt: Date.now(), zeroConf: { deviceID: DEVICE } };
  } });
  const state = await value.discovery.start(), baseline = value.counts();
  const body = 'action=addUser&userName=synthetic-user&blob=synthetic-blob&clientKey=synthetic-key';
  const response = await call(state.port, '/zc', { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).status, 101);
  assert.deepEqual(value.counts(), { freshCalls: baseline.freshCalls, getCalls: baseline.getCalls + 2 });
  assert.equal(value.received.at(-1).body, body);
  assert.equal(value.received.at(-1).headers.host, `127.0.0.1:${value.lease.soloistPort}`);
});

test('other peers, administration, duplicate/conflicting actions, methods and browser origins never reach upstream', async t => {
  const value = await fixture(t); const state = await value.discovery.start(); const baseline = value.received.length;
  const cases = [
    ['/api', {}, 404], ['/zc?action=resetUsers', {}, 400], ['/zc?action=addUser', {}, 400],
    ['/zc?action=getInfo&action=addUser', {}, 400], ['/zc?action=getInfo', { method: 'DELETE' }, 404],
    ['/zc', { method: 'POST', body: 'action=addUser', headers: { 'content-type': 'application/json' } }, 400],
    ['/zc?action=getInfo', { method: 'POST', body: 'action=addUser' }, 400],
    ['/zc', { method: 'POST', body: 'action=addUser&action=addUser' }, 400],
    ['/zc?action=getInfo', { headers: { origin: 'https://untrusted.example' } }, 400],
    ['/zc?action=getInfo', { headers: { 'sec-fetch-site': 'cross-site' } }, 400],
    ['/zc?action=getInfo', { localAddress: '127.0.0.2' }, 403],
  ];
  for (const [url, flags, status] of cases) assert.equal((await call(state.port, url, flags)).status, status, url);
  assert.equal(value.received.length, baseline);
});

test('request bodies exceeding the bound are rejected before guest pairing', async t => {
  const value = await fixture(t, { maximumBodyBytes: 1024 }); const state = await value.discovery.start(); const baseline = value.received.length;
  assert.equal((await call(state.port, '/zc', { method: 'POST', body: `action=addUser&blob=${'x'.repeat(1024)}` })).status, 413);
  assert.equal(value.received.length, baseline);
});

test('owned getInfo identity/name mismatch is not advertised; no arbitrary upstream URL is accepted', async t => {
  for (const changed of [{ deviceID: 'foreign-device' }, { remoteName: 'different-receiver' }]) {
    const value = await fixture(t, { info: { ...info(), ...changed } });
    await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_IDENTITY_CHANGED' }); assert.equal(value.mdnsInstances.length, 0);
    assert.deepEqual(value.discovery.status(), { available: false, closed: true });
  }
  const value = await fixture(t, { getChannel: () => ({ ...{ appliancePid: 718, applianceStartedAt: '2026-10-03T12:00:00.123Z' }, soloistPort: 'http://other.example' }) });
  await assert.rejects(value.discovery.start(), { code: 'DISCOVERY_IDENTITY_CHANGED' }); assert.equal(value.received.length, 0);
});

test('stale owned snapshot and missing non-loopback IPv4 fail with no announcement', async t => {
  const stale = await fixture(t, { readFresh: () => ({ receivedAt: Date.now() - 6000, zeroConf: { deviceID: DEVICE } }) });
  await assert.rejects(stale.discovery.start(), { code: 'DISCOVERY_IDENTITY_CHANGED' }); assert.equal(stale.received.length, 0);
  const empty = await fixture(t, { interfaces: { loopback: LAN.loopback, v6: LAN.v6 } });
  await assert.rejects(empty.discovery.start(), { code: 'DISCOVERY_INTERFACE_UNAVAILABLE' }); assert.equal(empty.mdnsInstances.length, 0);
});

test('lease port/PID/start time change before or during credential submission rejects the pairing reply', async t => {
  // This HTTP fixture checks the main lease fences. SDK listener/device proof
  // belongs to the guest relay and is not simulated by a changed readFresh value.
  for (const phase of ['before', 'during']) for (const change of [{ soloistPort: 65535 }, { appliancePid: 719 }, { applianceStartedAt: '2026-10-03T12:00:01.123Z' }]) {
    let replace = false;
    const value = await fixture(t, { getChannel: lease => ({ ...lease, ...(replace ? change : {}) }),
      handle: request => { if (phase === 'during' && request.method === 'POST') replace = true; return false; } });
    const state = await value.discovery.start(); replace = phase === 'before'; const baseline = value.received.length;
    const response = await call(state.port, '/zc', { method: 'POST', body: 'action=addUser&blob=sensitive' }).catch(error => ({ disconnected: error.code }));
    assert.ok(response.status === 502 || response.disconnected === 'ECONNRESET'); await value.discovery.close();
    assert.equal(value.received.length, baseline + (phase === 'during' ? 1 : 0)); assert.equal(value.discovery.status().available, false);
  }
});

test('oversized, redirected and disconnected guest replies are bounded and never exposed', async t => {
  for (const mode of ['oversize-header', 'oversize-stream', 'redirect', 'disconnect']) {
    const value = await fixture(t, { maximumBodyBytes: 1024, handle: (_request, response, _body, count) => {
      if (count === 1) return false;
      if (mode === 'oversize-header') { response.writeHead(200, { 'content-length': 2048 }); response.end('x'.repeat(2048)); }
      if (mode === 'oversize-stream') { response.writeHead(200); response.end('x'.repeat(2048)); }
      if (mode === 'redirect') { response.writeHead(302, { location: 'https://private.example' }); response.end(); }
      if (mode === 'disconnect') response.destroy();
      return true;
    } });
    const state = await value.discovery.start(); const result = await call(state.port, '/zc?action=getInfo');
    assert.equal(result.status, 502, mode); assert.equal(result.body, ''); assert.equal(result.headers.location, undefined);
  }
});

test('a total request timeout cancels stalled ownership/upstream; closing aborts in-flight pairing without raw errors', async t => {
  const value = await fixture(t, { timeoutMs: 100, handle: (_request, _response, _body, count) => count > 1 });
  const state = await value.discovery.start(); const began = Date.now();
  assert.equal((await call(state.port, '/zc?action=getInfo')).status, 504); assert.ok(Date.now() - began < 750);
  const inflight = call(state.port, '/zc', { method: 'POST', body: 'action=addUser&blob=sensitive' }).catch(error => ({ disconnected: error.code }));
  while (value.received.length < 3) await tick();
  await value.discovery.close(); const outcome = await inflight;
  assert.equal(outcome.disconnected, 'ECONNRESET'); assert.ok(value.mdnsInstances.every(item => item.destroyed));
  assert.equal(JSON.stringify(value.diagnostics).includes('sensitive'), false);
});

test('startup cancellation with a late owned channel cannot bind or announce', async t => {
  let release, observedSignal;
  const value = await fixture(t, { getChannel: (_lease, _count, signal) => { observedSignal = signal; return new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController(); const pending = value.discovery.start({ signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(observedSignal.aborted, true); release(value.lease); await tick();
  assert.equal(value.received.length, 0); assert.equal(value.mdnsInstances.length, 0); assert.equal(value.discovery.status().closed, true);
});

test('mDNS bind/publication failure and startup deadline clean every owned socket', async t => {
  for (const options of [{ mdnsError: true }, { mdnsWarning: true }, { publishError: Error('private multicast address') }, { holdMdns: true, timeoutMs: 100 }]) {
    const value = await fixture(t, options); await assert.rejects(value.discovery.start(), error => ['DISCOVERY_UNAVAILABLE', 'CANCELLED'].includes(error.code));
    assert.ok(value.mdnsInstances.every(item => item.destroyed)); assert.equal(value.discovery.status().available, false);
    assert.equal(JSON.stringify(value.diagnostics).includes('private multicast address'), false);
  }
});

test('stalled current-channel validation is covered by the same request deadline and client disconnect', async t => {
  let pendingSignal;
  const value = await fixture(t, { timeoutMs: 100, getChannel: (lease, count, signal) => {
    if (count > 3) { pendingSignal = signal; return new Promise(() => {}); }
    return { ...lease };
  } });
  const state = await value.discovery.start(); const baseline = value.received.length;
  assert.equal((await call(state.port, '/zc', { method: 'POST', body: 'action=addUser&blob=sensitive' })).status, 504);
  assert.equal(pendingSignal.aborted, true); assert.equal(value.received.length, baseline);
  const body = 'action=addUser&blob=sensitive';
  const outgoing = http.request({ hostname: '127.0.0.1', port: state.port, path: '/zc', method: 'POST', agent: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } });
  outgoing.on('error', () => {}); outgoing.end(body);
  while (!pendingSignal || pendingSignal.aborted) await tick();
  outgoing.destroy(); await tick(); await sleep(10);
  assert.equal(pendingSignal.aborted, true); assert.equal(value.received.length, baseline);
});

test('query responses stay in the advertised service, ignore malformed packets, and close sends TTL-zero goodbye', async t => {
  const value = await fixture(t); const state = await value.discovery.start();
  value.mdnsInstances[0].emit('warning', Error('private malformed DNS wire bytes'));
  value.mdnsInstances[0].emit('query', null); value.mdnsInstances[0].emit('query', { questions: [{ name: 'other._http._tcp.local', type: 'PTR' }] });
  assert.equal(value.advertisements.length, 2);
  value.mdnsInstances[0].emit('query', { questions: [{ name: '_SPOTIFY-CONNECT._TCP.LOCAL.', type: 'PTR' }] }); await tick();
  assert.equal(value.advertisements.length, 3);
  await value.discovery.close(); assert.ok(value.advertisements.slice(-2).every(value => value.packet.answers.every(record => record.ttl === 0)));
  assert.ok(value.mdnsInstances.every(item => item.destroyed)); await assert.rejects(call(state.port, '/zc?action=getInfo'));
  await assert.rejects(value.discovery.start(), { code: 'CANCELLED' }); await value.discovery.close();
});

test('renderer construction and invalid main configuration are rejected synchronously', () => {
  for (const config of [{}, { getChannel() {}, readFresh() {}, deviceName: '' }, { getChannel() {}, readFresh() {}, deviceName: 'bad\nname' },
    { getChannel() {}, readFresh() {}, deviceName: NAME, timeoutMs: 1 }]) assert.throws(() => createSoloistDiscovery(config), { code: 'INVALID_REQUEST' });
  const old = process.type;
  try { process.type = 'renderer'; assert.throws(() => createSoloistDiscovery({ getChannel() {}, readFresh() {}, deviceName: NAME }), { code: 'INVALID_REQUEST' }); }
  finally { if (old === undefined) delete process.type; else process.type = old; }
});
