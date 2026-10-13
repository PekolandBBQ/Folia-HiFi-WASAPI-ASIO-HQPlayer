'use strict';

// Source-only candidate. Import has no side effects. Only explicitly injected
// accessors, event registration, emitter, and clock can do anything external.
const MAX_TEXT = 256;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const ERRORS = Object.freeze([
  'BAD_OPTIONS', 'PLAYER_ACCESS_FAILED', 'PLAYER_UNAVAILABLE', 'EVENTS_UNAVAILABLE',
  'SUBSCRIBE_FAILED', 'DETACH_FAILED', 'SOURCE_READ_FAILED', 'SOURCE_MALFORMED',
  'CONNECT_ACCESS_FAILED', 'CONNECT_MALFORMED', 'LOCALITY_CONFLICT',
  'USER_ACCESS_FAILED', 'USER_UNAVAILABLE', 'ACCOUNT_READ_FAILED', 'ACCOUNT_MALFORMED',
  'EXPECTED_ACCOUNT_INVALID', 'CLOCK_FAILED', 'CLOCK_REGRESSION', 'EMIT_FAILED',
  'REENTRANT_INPUT_DROPPED', 'COUNTER_EXHAUSTED',
]);
const bump = (n) => Math.min(MAX_COUNT, n + 1);
const object = (v) => v !== null && typeof v === 'object';
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? v : null;
const boolean = (v) => typeof v === 'boolean' ? v : null;
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT && v.trim() === v && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) ? v : null;
const uri = (v) => typeof v === 'string' && /^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(v) ? v : null;
function freeze(value) {
  if (object(value)) { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}

function createDesktopStateObserver(options) {
  let getPlayerAPI, getConnectAPI, getUserAPI, emit, now, expectedAccountId;
  let optionsValid = true;
  try { ({ getPlayerAPI, getConnectAPI, getUserAPI, emit, now, expectedAccountId } = options || {}); }
  catch { optionsValid = false; }
  const faults = new Set();
  function fault(code) { if (ERRORS.includes(code)) faults.add(code); }
  if (!optionsValid || typeof getPlayerAPI !== 'function' || typeof emit !== 'function' || typeof now !== 'function') fault('BAD_OPTIONS');
  expectedAccountId = text(expectedAccountId);
  if (expectedAccountId === null) fault('EXPECTED_ACCOUNT_INVALID');
  let disposed = false, active = false, starting = false, stopping = false, generation = 0, connectionEpoch = 0;
  let bridgeSeq = 0, inputRevision = 0, droppedInputs = 0, emitted = 0;
  let lastReceiveTime = null, lastSourceTimestamp = null, busy = false;
  let binding = null, accountJob = null;
  let playerShape = 'unchecked', connectShape = 'unchecked', userShape = 'unchecked';
  let detachStatus = 'not-attached';
  let accountRevision = 0, accountComparison = 'unknown', accountReadState = 'never-read';
  let previousAccountComparison = null;
  let deviceRevision = 0, previousDevice = null;
  let lastDevice = { idKind: 'unknown', isLocal: null, locality: 'unknown', basis: 'none', conflict: false, revision: 0, changed: false };
  function read(obj, key, code) {
    if (!object(obj) && typeof obj !== 'function') return undefined;
    try { return obj[key]; } catch { fault(code); return undefined; }
  }
  function invokeAccessor(fn, code) {
    if (typeof fn !== 'function') { fault(code); return null; }
    try { return fn(); } catch { fault(code); return null; }
  }
  function record(value, code) {
    try { if (object(value) && !Array.isArray(value)) return value; } catch { fault(code); }
    return null;
  }
  function current(g) { return active && !disposed && g === generation; }
  function clock() {
    let result = null;
    try { result = number(now()); } catch { /* Fixed code below, never raw error. */ }
    if (result === null) fault('CLOCK_FAILED');
    if (result !== null && lastReceiveTime !== null && result < lastReceiveTime) fault('CLOCK_REGRESSION');
    if (result !== null) lastReceiveTime = result;
    return result;
  }
  function account() {
    return { comparison: accountComparison, comparisonReadSequence: accountRevision, readState: accountReadState,
      freshness: 'unknown', profileIdMapping: 'unverified', currentAccountBinding: 'unknown' };
  }
  function authority() {
    return { source: 'unknown', freshness: 'unknown', sourceOrder: 'unknown', barrier: 'unknown',
      officialDeviceBinding: 'unknown', nativeProcessBinding: 'unknown', pcm: 'unknown' };
  }
  function base(kind, receivedAt) {
    if (bridgeSeq === MAX_COUNT) { fault('COUNTER_EXHAUSTED'); stop(); return null; }
    bridgeSeq += 1;
    return { schemaVersion: 1, kind, connectionEpoch, bridgeSeq, receivedAt,
      receivedClock: 'injected-clock-unverified', authority: authority() };
  }
  function deliver(record, g) {
    if (!record || !current(g)) return false;
    const output = freeze({ ...record, errors: [...faults] });
    try { emit(output); emitted = bump(emitted); return true; }
    catch { fault('EMIT_FAILED'); stop(); return false; }
  }
  function projectSource(raw, kind, revisionBeforeRead, revisionAfterRead) {
    raw = record(raw, 'SOURCE_READ_FAILED');
    if (raw === null) fault('SOURCE_MALFORMED');
    const item = record(read(raw, 'item', 'SOURCE_READ_FAILED'), 'SOURCE_READ_FAILED');
    const timestamp = number(read(raw, 'timestamp', 'SOURCE_READ_FAILED'));
    let timestampRelation = 'unknown';
    if (timestamp !== null && lastSourceTimestamp !== null) {
      timestampRelation = timestamp < lastSourceTimestamp ? 'decreased' : timestamp === lastSourceTimestamp ? 'equal' : 'increased';
    }
    if (timestamp !== null) lastSourceTimestamp = timestamp;
    const position = number(read(raw, 'positionAsOfTimestamp', 'SOURCE_READ_FAILED'));
    const duration = number(read(raw, 'duration', 'SOURCE_READ_FAILED'));
    const positionConflict = position !== null && duration !== null && position > duration;
    return { kind, uri: uri(read(item, 'uri', 'SOURCE_READ_FAILED')),
      itemUid: text(read(item, 'uid', 'SOURCE_READ_FAILED')),
      isPaused: boolean(read(raw, 'isPaused', 'SOURCE_READ_FAILED')),
      isBuffering: boolean(read(raw, 'isBuffering', 'SOURCE_READ_FAILED')),
      positionAsOfTimestamp: positionConflict ? null : position, duration,
      positionConflict, timestamp, timestampClock: 'source-clock-unverified',
      timestampRelation, playbackId: text(read(raw, 'playbackId', 'SOURCE_READ_FAILED')),
      sessionId: text(read(raw, 'sessionId', 'SOURCE_READ_FAILED')),
      freshness: 'unknown', snapshotSemantics: kind === 'cached-snapshot' ? 'cached-state-read' : 'not-a-snapshot',
      updatesDuringRead: revisionAfterRead !== revisionBeforeRead,
      subscribeSnapshotBarrier: 'unknown', identifierSemantics: 'opaque-unverified',
      restrictions: 'unknown-unprojected' };
  }
  function projectDevice() {
    const api = record(invokeAccessor(getConnectAPI, 'CONNECT_ACCESS_FAILED'), 'CONNECT_ACCESS_FAILED');
    const state = record(read(api, 'state', 'CONNECT_ACCESS_FAILED'), 'CONNECT_ACCESS_FAILED');
    const device = record(read(state, 'activeDevice', 'CONNECT_ACCESS_FAILED'), 'CONNECT_ACCESS_FAILED');
    const id = text(read(device, 'id', 'CONNECT_ACCESS_FAILED'));
    const isLocal = boolean(read(device, 'isLocal', 'CONNECT_ACCESS_FAILED'));
    connectShape = device !== null ? 'candidate-fields' : 'unavailable';
    if (connectShape === 'unavailable') fault('CONNECT_MALFORMED');
    const idKind = id === null ? 'unknown' : id === 'local_device' ? 'local-sentinel' : 'opaque';
    // Separate public consumers use these indicators; no source proves that
    // every local device must have the sentinel. An opaque ID is not remote proof.
    const conflict = idKind === 'local-sentinel' && isLocal === false;
    if (conflict) fault('LOCALITY_CONFLICT');
    const locality = conflict ? 'unknown' : idKind === 'local-sentinel' || isLocal === true ? 'local-candidate'
      : isLocal === false ? 'remote-candidate' : 'unknown';
    const basis = conflict ? 'conflicting-indicators' : idKind === 'local-sentinel' && isLocal === true ? 'sentinel-and-flag'
      : idKind === 'local-sentinel' ? 'sentinel' : isLocal === true ? 'local-flag' : isLocal === false ? 'remote-flag' : 'none';
    const changed = previousDevice !== null && (previousDevice.id !== id || previousDevice.isLocal !== isLocal);
    if (changed || previousDevice === null) deviceRevision = bump(deviceRevision);
    previousDevice = { id, isLocal }; // Memory only; never emitted or in reports.
    lastDevice = { idKind, isLocal, locality, basis, conflict, revision: deviceRevision, changed };
    return { ...lastDevice, provenance: 'ConnectAPI.state.activeDevice-read-at-receipt', freshness: 'unknown',
      eventAtomicity: 'unknown', officialDeviceId: 'unknown' };
  }
  function observe(kind, event, g) {
    if (!current(g)) return false;
    if (busy) { fault('REENTRANT_INPUT_DROPPED'); droppedInputs = bump(droppedInputs); return false; }
    busy = true;
    try {
      const receivedAt = clock();
      if (!current(g)) return false;
      const before = inputRevision;
      const raw = kind === 'raw-update' ? read(event, 'data', 'SOURCE_READ_FAILED') : read(binding.player, '_state', 'SOURCE_READ_FAILED');
      const after = inputRevision;
      const source = projectSource(raw, kind, before, after);
      if (!current(g)) return false;
      const device = projectDevice();
      if (!current(g)) return false;
      source.updatesDuringRead = source.updatesDuringRead || inputRevision !== before;
      const envelope = base('observation', receivedAt);
      return deliver(envelope && { ...envelope, source, device, account: account() }, g);
    } catch { fault('SOURCE_READ_FAILED'); return false; }
    finally { busy = false; }
  }
  function cancelAccount() {
    if (!accountJob) return;
    const job = accountJob; accountJob = null;
    job.resolve(freeze({ ok: false, code: 'CANCELLED' }));
  }
  function stop() {
    if (stopping) return freeze({ ok: true, code: 'STOPPED' });
    stopping = true;
    active = false;
    generation = bump(generation);
    cancelAccount();
    accountComparison = 'unknown'; accountReadState = 'invalidated';
    const old = binding; binding = null;
    if (old) {
      try { old.remove.call(old.events, 'update', old.listener); detachStatus = 'detached-call-returned'; }
      catch { fault('DETACH_FAILED'); detachStatus = 'detach-unverified'; }
    }
    stopping = false;
    return freeze({ ok: detachStatus !== 'detach-unverified', code: detachStatus === 'detach-unverified' ? 'DETACH_FAILED' : 'STOPPED' });
  }
  function startImpl() {
    if (disposed) return freeze({ ok: false, code: 'DISPOSED' });
    if (active) return freeze({ ok: true, code: 'ALREADY_STARTED', connectionEpoch });
    if (faults.has('BAD_OPTIONS')) return freeze({ ok: false, code: 'BAD_OPTIONS' });
    const startGeneration = generation;
    const player = record(invokeAccessor(getPlayerAPI, 'PLAYER_ACCESS_FAILED'), 'PLAYER_ACCESS_FAILED');
    if (player === null) { fault('PLAYER_UNAVAILABLE'); playerShape = 'unavailable'; return freeze({ ok: false, code: 'PLAYER_UNAVAILABLE' }); }
    const events = read(player, '_events', 'PLAYER_ACCESS_FAILED');
    const add = read(events, 'addListener', 'PLAYER_ACCESS_FAILED');
    const remove = read(events, 'removeListener', 'PLAYER_ACCESS_FAILED');
    if (typeof add !== 'function' || typeof remove !== 'function') {
      fault('EVENTS_UNAVAILABLE'); playerShape = 'unavailable'; return freeze({ ok: false, code: 'EVENTS_UNAVAILABLE' });
    }
    if (disposed) return freeze({ ok: false, code: 'DISPOSED' });
    if (generation !== startGeneration) return freeze({ ok: false, code: 'CANCELLED' });
    if (connectionEpoch === MAX_COUNT || generation === MAX_COUNT) { fault('COUNTER_EXHAUSTED'); return freeze({ ok: false, code: 'COUNTER_EXHAUSTED' }); }
    connectionEpoch += 1; generation += 1;
    const g = generation;
    active = true; playerShape = 'raw-update-shape';
    accountComparison = 'unknown'; accountReadState = 'never-read'; previousAccountComparison = null;
    previousDevice = null; lastSourceTimestamp = null;
    // A callback synchronously fired during addListener is observable but has
    // no completed-subscription guarantee; the initial snapshot stays cached.
    const listener = (event) => {
      if (!current(g)) return;
      inputRevision = bump(inputRevision);
      observe('raw-update', event, g);
    };
    binding = { player, events, remove, listener };
    try { add.call(events, 'update', listener); }
    catch { fault('SUBSCRIBE_FAILED'); if (current(g)) stop(); return freeze({ ok: false, code: 'SUBSCRIBE_FAILED' }); }
    if (!current(g)) {
      // Reentrant stop/dispose may precede the provider finishing registration.
      try { remove.call(events, 'update', listener); } catch { fault('DETACH_FAILED'); detachStatus = 'detach-unverified'; }
      return freeze({ ok: false, code: disposed ? 'DISPOSED' : 'CANCELLED' });
    }
    detachStatus = 'attached';
    snapshot();
    return freeze({ ok: current(g), code: current(g) ? 'STARTED' : 'CANCELLED', connectionEpoch });
  }
  function start() {
    if (stopping) return freeze({ ok: false, code: 'STOP_IN_PROGRESS' });
    if (starting) return freeze({ ok: false, code: 'START_IN_PROGRESS' });
    starting = true;
    try { return startImpl(); }
    catch { fault('PLAYER_ACCESS_FAILED'); stop(); return freeze({ ok: false, code: 'PLAYER_ACCESS_FAILED' }); }
    finally { starting = false; }
  }
  function snapshot() {
    if (!active || disposed) return freeze({ ok: false, code: disposed ? 'DISPOSED' : 'NOT_STARTED' });
    const ok = observe('cached-snapshot', null, generation);
    return freeze({ ok, code: ok ? 'SNAPSHOT_EMITTED' : 'SNAPSHOT_NOT_EMITTED' });
  }
  function refreshAccount() {
    if (!active || disposed) return Promise.resolve(freeze({ ok: false, code: disposed ? 'DISPOSED' : 'NOT_STARTED' }));
    if (accountJob) return accountJob.promise;
    const g = generation;
    accountComparison = 'unknown'; accountReadState = 'pending';
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const job = { promise, resolve, g }; accountJob = job;
    function finish(comparison, code) {
      if (accountJob !== job || !current(g)) return;
      accountJob = null;
      accountRevision = bump(accountRevision);
      const comparisonChanged = previousAccountComparison !== null && previousAccountComparison !== comparison;
      previousAccountComparison = comparison;
      accountComparison = comparison; accountReadState = code === 'ACCOUNT_COMPARED' ? 'completed-cache-possible' : 'unavailable';
      const receivedAt = clock();
      if (!current(g)) { resolve(freeze({ ok: false, code: 'CANCELLED' })); return; }
      const envelope = base('account-comparison', receivedAt);
      deliver(envelope && { ...envelope, account: account(), comparisonChanged }, g);
      resolve(freeze({ ok: code === 'ACCOUNT_COMPARED', code, comparison }));
    }
    const userAPI = record(invokeAccessor(getUserAPI, 'USER_ACCESS_FAILED'), 'USER_ACCESS_FAILED');
    if (!current(g) || accountJob !== job) return promise;
    const getUser = read(userAPI, 'getUser', 'USER_ACCESS_FAILED');
    if (!current(g) || accountJob !== job) return promise;
    if (expectedAccountId === null) { finish('unknown', 'EXPECTED_ACCOUNT_INVALID'); return promise; }
    if (typeof getUser !== 'function') { fault('USER_UNAVAILABLE'); userShape = 'unavailable'; finish('unknown', 'USER_UNAVAILABLE'); return promise; }
    userShape = 'getUser-shape';
    try {
      const result = getUser.call(userAPI);
      Promise.resolve(result).then((user) => {
        if (accountJob !== job || !current(g)) return;
        const value = text(read(record(user, 'ACCOUNT_READ_FAILED'), 'username', 'ACCOUNT_READ_FAILED'));
        if (value === null) { fault('ACCOUNT_MALFORMED'); finish('unknown', 'ACCOUNT_MALFORMED'); }
        else finish(value === expectedAccountId ? 'match' : 'mismatch', 'ACCOUNT_COMPARED');
      }, () => { if (accountJob === job && current(g)) { fault('ACCOUNT_READ_FAILED'); finish('unknown', 'ACCOUNT_READ_FAILED'); } });
    } catch { fault('ACCOUNT_READ_FAILED'); finish('unknown', 'ACCOUNT_READ_FAILED'); }
    return promise;
  }
  function getSupportReport() {
    return freeze({ schemaVersion: 1, scope: 'source-only-candidate', lifecycle: disposed ? 'disposed' : active ? 'started' : 'stopped',
      connectionEpoch, emitted, bridgeSeq, inputRevision, droppedInputs, detachStatus,
      candidateShapes: { player: playerShape, connect: connectShape, user: userShape },
      account: account(), device: { ...lastDevice }, errors: [...faults], authority: authority(),
      runtimeSemantics: 'unverified', admission: 'unsupported', latencyGate: 'not-measured',
      observationsAre: 'diagnostic-candidates-only' });
  }
  function dispose() {
    if (!disposed) { disposed = true; stop(); expectedAccountId = null; previousDevice = null; }
    return freeze({ ok: detachStatus !== 'detach-unverified', code: 'DISPOSED' });
  }
  return Object.freeze({ start, snapshot, refreshAccount, stop, dispose, getSupportReport });
}

module.exports = Object.freeze({ createDesktopStateObserver, SAFE_ERROR_CODES: ERRORS });
