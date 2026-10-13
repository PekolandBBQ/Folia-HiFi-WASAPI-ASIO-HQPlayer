const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createOwnedSoloistAppliance } = require('../../electron/spotify/soloistOwnedAppliance.cjs');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');

// Only synthetic owner/process channels are used. These tests never boot a
// guest, invoke SSH or read credentials, paired disks or live account state.
const SSH_BYTES = Buffer.from('trusted public SSH fixture');
const SHA = 'b'.repeat(64), URI = 'spotify:track:003vvx7Niy0yvhvHt4a68B';
const tick = () => new Promise(resolve => setImmediate(resolve));
const lease = () => ({ pid: 873, startedAt: '2026-10-03T10:30:01.123Z', owned: true, guestReady: false,
  ports: { ssh: 51311, musicAssistant: 51312, pcm: 51313, soloist: 51314 },
  baseImage: 'C:\\public\\clean-base.qcow2', overlayImage: 'C:\\private\\owned-overlay.qcow2' });
const daemon = () => ({ pid: 71, startTicks: '710', uid: 1001, executableDevice: 1, executableInode: 99,
  executableSha256: SHA, wsPort: 37101, zeroConfPort: 44211, wsSocketPid: 71, zeroConfSocketPid: 71,
  wsSocketStartTicks: '710', zeroConfSocketStartTicks: '710' });
const snapshot = () => ({ owner: daemon(), receivedAt: 1791000000000, readiness: 'ready',
  authState: { logged_in: true, is_active: true },
  playback: { status: 'paused', uri: URI, durationMs: 10000, positionMs: 1000, speed: 0 },
  zeroConf: { deviceID: 'synthetic-device', spotifyError: 0, status: 101 } });
const seek = () => ({ owner: `71:710:37101:44211:1001:1:99:${SHA}`, expectedUri: URI,
  expectedStatus: 'paused', expectedPositionMs: 1000, toleranceMs: 100, positionMs: 3000 });
function fixture(options = {}) {
  const calls = [], children = []; let starts = 0, statuses = 0, fileReads = 0;
  const owned = lease();
  const owner = {
    start: options.start || (() => { starts++; return owned; }),
    status: options.status || (() => { statuses++; return { ...owned, state: 'running',
      ...(options.changedLease && statuses >= 2 ? options.changedLease : {}) }; }),
  };
  const spawnProcess = (file, args, flags) => {
    if (options.spawnFailure) throw Error('private path/token fixture must not escape');
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kills = 0;
    child.kill = () => { child.kills++; if (options.killThrows) throw Error('already reaped'); };
    child.respond = (response, code = 0) => {
      child.stdout.emit('data', Buffer.isBuffer(response) ? response : Buffer.from(response)); child.emit('close', code);
    };
    child.stdin.end = body => {
      calls.push({ file, args, flags, body });
      if (options.endThrows) throw Error('private EPIPE fixture');
      if (options.hold) return;
      setImmediate(() => {
        if (options.pipeError) { child.stdin.emit('error', Object.assign(Error('private EPIPE'), { code: 'EPIPE' })); return; }
        const request = JSON.parse(body);
        const result = options.result || { ok: true, result: request.operation === 'readFresh' ? snapshot() : { acknowledged: true, wsPositionObserved: true } };
        child.respond(options.raw || JSON.stringify(result), options.exit || 0);
      });
    };
    children.push(child); return child;
  };
  const adapter = createOwnedSoloistAppliance({ owner, keyPath: 'C:\\private\\client-key', knownHostsPath: 'C:\\private\\known-hosts',
    sshExecutablePath: 'C:\\public\\ssh.exe', sshExecutableSha256: createHash('sha256').update(SSH_BYTES).digest('hex'),
    assets: options.assets === undefined ? { soloistSha256: SHA } : options.assets,
    resolveAssetContract: options.resolveAssetContract,
    readPublicFile: () => { fileReads++; return options.sshBytes || SSH_BYTES; }, spawnProcess,
    timeoutMs: options.timeoutMs || 1000, now: () => 1791000000100 });
  return { adapter, owner, owned, calls, children, counts: () => ({ starts, statuses, fileReads }) };
}

test('catalog construction is zero I/O; fresh channel uses owned ISO lease, dynamic ports and folia UID', async () => {
  const value = fixture(); assert.deepEqual(value.counts(), { starts: 0, statuses: 0, fileReads: 0 });
  const result = await value.adapter.readFresh(); assert.deepEqual(result, { ...snapshot(), receivedAt: 1791000000100 });
  const call = value.calls[0]; assert.equal(call.file, 'C:\\public\\ssh.exe');
  assert.deepEqual(call.flags, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(call.args[call.args.indexOf('-p') + 1], '51311'); assert.ok(call.args.includes('folia@127.0.0.1'));
  assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
  assert.equal(call.args.at(-1), '/opt/folia/venv/bin/python -I /opt/folia/owned-appliance-control.py');
  assert.equal(call.body, JSON.stringify({ operation: 'readFresh', soloistSha256: SHA }));
  assert.deepEqual(value.counts(), { starts: 1, statuses: 2, fileReads: 1 });
});

test('getChannel returns the verified SSH executable and dynamic main-only channel without SSH commands', async () => {
  const value = fixture(); const channel = await value.adapter.getChannel();
  assert.equal(channel.sshExecutablePath, 'C:\\public\\ssh.exe'); assert.equal(channel.sshPort, 51311);
  assert.equal(channel.pcmPort, 51313); assert.equal(channel.musicAssistantPort, 51312); assert.equal(channel.user, 'folia');
  assert.equal(channel.appliancePid, 873); assert.equal(channel.applianceStartedAt, value.owned.startedAt);
  assert.equal(value.calls.length, 0); assert.equal(Object.isFrozen(channel), true);
});

test('unpaired owned daemon is explicitly pairing-required without claiming playable authentication', async () => {
  const result = snapshot(); result.authState = { logged_in: false, is_active: false }; result.readiness = 'pairing-required';
  result.playback = { status: null, uri: null, durationMs: null, positionMs: null, speed: null };
  const received = await fixture({ result: { ok: true, result } }).adapter.readFresh();
  assert.equal(received.readiness, 'pairing-required'); assert.equal(received.authState.logged_in, false);
  assert.deepEqual(received.playback, { status: null, uri: null, durationMs: null, positionMs: null, speed: null });
});

test('missing external asset attestation cannot use a guest self-reported digest', async () => {
  for (const assets of [null, {}, { soloistSha256: 'untrusted' }]) {
    const value = fixture({ assets }); await assert.rejects(value.adapter.readFresh(), { code: 'SOLOIST_ASSET_UNVERIFIED' });
    assert.equal(value.calls.length, 0);
  }
});

test('main asset resolver receives the actual owned lease and never injects asset paths into the guest command', async () => {
  let received; const value = fixture({ resolveAssetContract: async input => { received = input; return { soloistSha256: SHA, provenance: 'main catalog' }; } });
  await value.adapter.readFresh(); assert.equal(received.lease.pid, 873); assert.equal(received.lease.ports.ssh, 51311);
  assert.equal(Object.isFrozen(received.lease), true); assert.equal(Object.isFrozen(received.lease.ports), true);
  assert.deepEqual(JSON.parse(value.calls[0].body), { operation: 'readFresh', soloistSha256: SHA });
});

test('foreign, stopped and malformed leases are rejected before SSH', async () => {
  for (const change of [{ owned: false }, { pid: 0 }, { startedAt: 1791000000000 },
    { ports: { ssh: 51311, musicAssistant: 51311, pcm: 51313, soloist: 51314 } }]) {
    const value = fixture(); Object.assign(value.owned, change);
    await assert.rejects(value.adapter.readFresh(), { code: 'APPLIANCE_UNAVAILABLE' }); assert.equal(value.calls.length, 0);
  }
  const value = fixture({ status: () => ({ ...lease(), state: 'stopped' }) });
  await assert.rejects(value.adapter.readFresh(), { code: 'APPLIANCE_CHANGED' }); assert.equal(value.calls.length, 0);
});

test('appliance restart, PID reuse, changed image and changed ports invalidate an already returned guest observation', async () => {
  for (const changedLease of [{ pid: 874 }, { startedAt: '2026-10-03T10:30:02.123Z' },
    { overlayImage: 'C:\\private\\different-overlay.qcow2' }, { ports: { ...lease().ports, ssh: 51411 } }]) {
    const value = fixture({ changedLease }); await assert.rejects(value.adapter.readFresh(), { code: 'APPLIANCE_CHANGED' });
    assert.equal(value.calls.length, 1);
  }
});

test('a different local SSH executable hash launches no control process', async () => {
  const value = fixture({ sshBytes: Buffer.from('modified executable') });
  await assert.rejects(value.adapter.readFresh(), { code: 'APPLIANCE_CHANNEL_UNAVAILABLE' }); assert.equal(value.calls.length, 0);
});

test('strict snapshot projection rejects extra private fields, wrong binary and socket lifecycle mismatch', async () => {
  const invalid = [];
  let result = snapshot(); result.token = 'private'; invalid.push(result);
  result = snapshot(); result.owner.executableSha256 = 'c'.repeat(64); invalid.push(result);
  result = snapshot(); result.owner.wsSocketPid = 72; invalid.push(result);
  result = snapshot(); result.owner.zeroConfSocketStartTicks = '711'; invalid.push(result);
  result = snapshot(); result.authState.userName = 'private'; invalid.push(result);
  result = snapshot(); result.readiness = 'pairing-required'; invalid.push(result);
  result = snapshot(); result.playback.positionMs = 3600001; invalid.push(result);
  for (const item of invalid) await assert.rejects(fixture({ result: { ok: true, result: item } }).adapter.readFresh(), { code: 'OWNED_PROTOCOL_INVALID' });
});

test('duplicate nested or escaped JSON keys, invalid UTF-8, excessive depth and trailing data are rejected', async () => {
  const valid = JSON.stringify({ ok: true, result: snapshot() });
  for (const raw of [valid.replace('"logged_in":true', '"logged_in":false,"logged_in":true'),
    valid.replace('"ok":true', '"ok":false,"\\u006fk":true'), Buffer.from([0xff, 0xfe]),
    '['.repeat(33) + '0' + ']'.repeat(33), valid + '{}'])
    await assert.rejects(fixture({ raw }).adapter.readFresh(), { code: 'OWNED_PROTOCOL_INVALID' });
});

test('only declared public readiness/failure codes escape a guest failure', async () => {
  for (const code of ['SOLOIST_INSTALL_REQUIRED', 'SOLOIST_STARTING', 'MA_SERVICE_UNAVAILABLE'])
    await assert.rejects(fixture({ result: { ok: false, code }, exit: 1 }).adapter.readFresh(), { code });
  for (const result of [{ ok: false, code: 'PRIVATE_SECRET' }, { ok: false, code: 'token=private' },
    { ok: false, code: 'SOLOIST_STARTING', token: 'private' }]) {
    const value = fixture({ result, exit: 1 });
    await assert.rejects(value.adapter.readFresh(), error => error.code === 'APPLIANCE_CHANNEL_UNAVAILABLE' && !error.message.includes('private'));
  }
});
test('safe auth rejection metadata is projected as a frozen nonenumerable diagnostic and legacy errors still work', async () => {
  const diagnostic = { stage: 'initial-auth', reason: 'frame-type', frameType: 'CLOSE',
    topLevelType: 'missing', eventType: 'missing', loggedInType: 'missing', isActiveType: 'missing', closeCode: 1006 };
  const value = fixture({ result: { ok: false, code: 'AUTH_SCHEMA_INVALID', diagnostic }, exit: 1 });
  await assert.rejects(value.adapter.readFresh(), error => {
    assert.equal(error.code, 'AUTH_SCHEMA_INVALID'); assert.deepEqual(error.diagnostic, diagnostic);
    assert.equal(Object.isFrozen(error.diagnostic), true);
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'diagnostic'), {
      value: diagnostic, enumerable: false, writable: false, configurable: false,
    });
    assert.equal(JSON.stringify(error).includes('diagnostic'), false); return true;
  });
  assert.equal(value.calls.length, 1);
  await assert.rejects(fixture({ result: { ok: false, code: 'AUTH_SCHEMA_INVALID' }, exit: 1 }).adapter.readFresh(),
    error => error.code === 'AUTH_SCHEMA_INVALID' && !Object.hasOwn(error, 'diagnostic'));
});
test('auth diagnostic envelopes reject unknown fields values stages types and unbounded close codes', async () => {
  const base = { stage: 'state-auth', reason: 'logged-in-type', frameType: 'TEXT', topLevelType: 'object',
    eventType: 'string', loggedInType: 'string', isActiveType: 'boolean' };
  for (const diagnostic of [{ ...base, payload: 'private-auth-token' }, { ...base, stage: 'private-auth-token' },
    { ...base, reason: 'private-auth-token' }, { ...base, frameType: 'private-auth-token' },
    { ...base, topLevelType: 'private-auth-token' }, { ...base, eventType: 'auth_state' },
    { ...base, loggedInType: true }, { ...base, isActiveType: null }, ...[-1, 65536, 1000.5, '1000', true].map(closeCode => ({ ...base, closeCode })),
    { ...base, reason: undefined }, null, []]) {
    const value = fixture({ result: { ok: false, code: 'AUTH_SCHEMA_INVALID', diagnostic }, exit: 1 });
    await assert.rejects(value.adapter.readFresh(), error => {
      assert.equal(error.code, 'APPLIANCE_CHANNEL_UNAVAILABLE'); assert.equal(Object.hasOwn(error, 'diagnostic'), false);
      assert.equal(String(error).includes('private'), false); return true;
    });
    assert.equal(value.calls.length, 1);
  }
  await assert.rejects(fixture({ result: { ok: false, code: 'OWNER_CHANGED', diagnostic: base }, exit: 1 }).adapter.readFresh(),
    { code: 'APPLIANCE_CHANNEL_UNAVAILABLE' });
  for (const stage of ['initial-auth', 'state-auth', 'seek-auth']) {
    await assert.rejects(fixture({ result: { ok: false, code: 'AUTH_SCHEMA_INVALID', diagnostic: { ...base, stage } }, exit: 1 }).adapter.readFresh(),
      error => error.code === 'AUTH_SCHEMA_INVALID' && error.diagnostic.stage === stage);
  }
});
test('private auth journal observes existing reads only and disabled instrumentation remains inert', async t => {
  let enabled = false; const rows = [];
  const remove = installPreviewDiagnosticSink({ enabled: () => enabled, record: (type, fields) => rows.push({ type, fields }) });
  t.after(remove);
  const value = fixture(); await value.adapter.readFresh();
  assert.equal(rows.length, 0); assert.equal(value.calls.length, 1);
  enabled = true; const result = await value.adapter.readFresh(); await tick();
  assert.equal(result.authState.logged_in, true); assert.equal(value.calls.length, 2);
  assert.deepEqual(rows.map(row => [row.type, row.fields.phase]), [['spotify.auth-read', 'request'], ['spotify.auth-read', 'result']]);
  assert.equal(rows[1].fields.authenticated, true); assert.equal(rows[1].fields.active, true);
  const diagnostic = { stage: 'state-auth', reason: 'is-active-type', frameType: 'TEXT', topLevelType: 'object',
    eventType: 'string', loggedInType: 'boolean', isActiveType: 'number' };
  const broken = fixture({ result: { ok: false, code: 'AUTH_SCHEMA_INVALID', diagnostic }, exit: 1 });
  await assert.rejects(broken.adapter.readFresh(), { code: 'AUTH_SCHEMA_INVALID' }); await tick();
  assert.equal(broken.calls.length, 1); assert.equal(rows.at(-1).fields.errorCode, 'AUTH_SCHEMA_INVALID');
  assert.equal(rows.at(-1).fields.stage, 'state-auth'); assert.equal(rows.at(-1).fields.isActiveType, 'number');
  enabled = false; const count = rows.length; await value.adapter.readFresh(); assert.equal(rows.length, count);
  assert.equal(value.calls.length, 3);
});

test('oversized stdout is bounded and kills only the pending control child', async () => {
  const value = fixture({ raw: 'x'.repeat(65537) });
  await assert.rejects(value.adapter.readFresh(), { code: 'OWNED_PROTOCOL_INVALID' }); assert.equal(value.children[0].kills, 1);
});

test('pre-aborted read or invalid seek performs no owner/channel I/O', async () => {
  const value = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(value.adapter.readFresh({ signal: controller.signal }), { code: 'CANCELLED' });
  for (const request of [{ ...seek(), expectedStatus: 'playing' }, { ...seek(), owner: '7:' + SHA },
    { ...seek(), expectedUri: 'file:///unsafe' }, { ...seek(), toleranceMs: 1001 }, { ...seek(), path: '/unsafe' }])
    await assert.rejects(value.adapter.seekOwnedPaused(request), { code: 'INVALID_REQUEST' });
  assert.deepEqual(value.counts(), { starts: 0, statuses: 0, fileReads: 0 }); assert.equal(value.calls.length, 0);
});

test('cancelled pending control is killed promptly and cannot report a later valid result', async () => {
  const value = fixture({ hold: true }), controller = new AbortController();
  const pending = value.adapter.readFresh({ signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(value.children[0].kills, 1);
  value.children[0].respond(JSON.stringify({ ok: true, result: snapshot() }));
  assert.equal(value.counts().statuses, 1);
});

test('cancellation while waiting for owner or official asset resolves without a late SSH launch', async () => {
  for (const stage of ['owner', 'asset']) {
    let release; const held = new Promise(resolve => { release = resolve; });
    const value = fixture(stage === 'owner' ? { start: () => held } : { resolveAssetContract: () => held });
    const controller = new AbortController(), pending = value.adapter.readFresh({ signal: controller.signal });
    await tick(); controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
    release(stage === 'owner' ? lease() : { soloistSha256: SHA }); await tick(); assert.equal(value.calls.length, 0);
  }
});

test('timeout is bounded and pipe errors, synchronous EPIPE and reaped-child kill errors never escape raw', async () => {
  const timed = fixture({ hold: true, timeoutMs: 100 });
  await assert.rejects(timed.adapter.readFresh(), { code: 'OWNED_CONTROL_TIMEOUT' }); assert.equal(timed.children[0].kills, 1);
  for (const options of [{ pipeError: true }, { endThrows: true }, { spawnFailure: true }, { endThrows: true, killThrows: true }])
    await assert.rejects(fixture(options).adapter.readFresh(), error => error.code === 'APPLIANCE_CHANNEL_UNAVAILABLE' && !error.message.includes('private'));
});

test('only strict guarded-seek acknowledgement is accepted, preserving request safeguards', async () => {
  const value = fixture(); assert.deepEqual(await value.adapter.seekOwnedPaused(seek()), { acknowledged: true, wsPositionObserved: true });
  assert.deepEqual(JSON.parse(value.calls[0].body), { operation: 'seekOwnedPaused', soloistSha256: SHA, request: seek() });
  for (const result of [{ acknowledged: true, wsPositionObserved: false }, { acknowledged: true, wsPositionObserved: true, rawState: 'private' }])
    await assert.rejects(fixture({ result: { ok: true, result } }).adapter.seekOwnedPaused(seek()), { code: 'OWNED_PROTOCOL_INVALID' });
});

test('serialized controls do not overlap and a cancelled queued request never creates a child', async () => {
  const value = fixture({ hold: true }), controller = new AbortController();
  const first = value.adapter.readFresh(), second = value.adapter.seekOwnedPaused(seek(), { signal: controller.signal });
  await tick(); assert.equal(value.calls.length, 1); controller.abort();
  value.children[0].respond(JSON.stringify({ ok: true, result: snapshot() })); await first;
  await assert.rejects(second, { code: 'CANCELLED' }); assert.equal(value.calls.length, 1);
});
