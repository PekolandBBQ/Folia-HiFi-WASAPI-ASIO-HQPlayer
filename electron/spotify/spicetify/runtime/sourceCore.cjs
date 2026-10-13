'use strict';
const { copyData } = require('./boundedPair.cjs');
const { command: checkedCommand } = require('../vendor/stage05/commands/command-schema.cjs');
// Shared by legitimate sourceCore instances from this runtime module. A newer
// writer of the same record replaces the marker; old cleanup cannot clear it.
const mutationOwners = new WeakMap();

// runtime/sourceCore.cjs: main-process dependency boundary. Authority is a private capability, never bridge data.
const fail = code => Object.assign(new Error(code), { code });
const noItem = value => value?.itemState === 'no-item';
const sameStamp = (a, b) => Number.isSafeInteger(a?.epoch) && Number.isSafeInteger(a?.revision)
  && a.epoch === b?.epoch && a.revision === b?.revision;
function createSourceCore({ port, authority, now = Date.now, timeoutMs = 4000, commandContext }) {
  if (!port || !authority || !['authorize', 'stamp', 'snapshot', 'devices', 'validate', 'completeMutation', 'assertDispatch'].every(key => typeof authority[key] === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('PROTOCOL_INVALID');
  if (commandContext != null && typeof commandContext.bind !== 'function') throw fail('PROTOCOL_INVALID');
  const observations = new WeakMap(), identities = new WeakMap(), initialRecords = new WeakMap(), unresolved = new Set();
  const initialSignature = record => {
    const data = {};
    for (const key of ['stamp', 'sourceSession', 'session', 'deviceId', 'trackId', 'durationMs']) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail('SESSION_OBSERVATION_UNTRUSTED');
      data[key] = descriptor.value;
    }
    return JSON.stringify(copyData(data));
  };
  const initialCurrent = record => {
    const value = initialRecords.get(record);
    if (!value || value.signature !== initialSignature(record)) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    return value;
  };
  let closed = false, observationEpoch = 0, lastObservedAt = -1, lastDiagnostic = null;
  const detach = port.subscribe(frame => {
    // Events only improve diagnostics. Their sequence, time and cached data confer no control authority.
    if (!closed && frame.type === 'observation') lastDiagnostic = frame.record;
  });
  port.onClose(() => { closed = true; observationEpoch++; detach(); });
  const check = (record, current, signal) => {
    if (closed) throw fail('CLOSED');
    current();
    if (signal?.aborted) throw fail('CANCELLED');
    if (record && !sameStamp(record.stamp, authority.stamp())) throw fail('SESSION_CHANGED');
  };
  async function bounded(action, signal, current) {
    check(null, current, signal);
    let timer, abort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('CONTROL_TIMEOUT')), timeoutMs);
      abort = () => reject(fail('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([Promise.resolve().then(action), deadline]); check(null, current, signal); return result; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function authorize(current) {
    check(null, current);
    const stamp = await bounded(() => authority.authorize(), undefined, current);
    if (!sameStamp(stamp, authority.stamp())) throw fail('SESSION_CHANGED');
    return Object.freeze({ epoch: stamp.epoch, revision: stamp.revision });
  }
  // Admission creates an opaque receipt only after an independent source authority supplies an ordered snapshot.
  async function snapshot(record, current, signal, allowInitialNoItem = false) {
    const epoch = observationEpoch;
    const receipt = await bounded(() => authority.snapshot({ record, signal, allowInitialNoItem }), signal, current);
    check(record, current, signal);
    if (epoch !== observationEpoch || unresolved.size) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    const saved = authority.validate(receipt, { record });
    if (!saved || !sameStamp(saved.stamp, record.stamp)) throw fail('SESSION_CHANGED');
    const facts = copyData(saved.facts);
    if (noItem(facts)) {
      const prior = initialRecords.get(record);
      if (!allowInitialNoItem || saved.kind !== 'no-item' || prior && initialCurrent(record).phase !== 'ready'
        || Object.hasOwn(facts, 'trackId') || Object.hasOwn(facts, 'durationMs') || Object.hasOwn(facts, 'positionMs')
        || facts.deviceId !== record.deviceId || facts.isPlaying !== false || facts.restricted !== false
        || typeof facts.isActive !== 'boolean' || typeof commandContext?.confirmSelected !== 'function')
        throw fail('SESSION_OBSERVATION_UNTRUSTED');
    }
    if (!Number.isFinite(facts.observedAt) || facts.observedAt > now() || now() - facts.observedAt >= 5000
      || facts.observedAt < lastObservedAt) throw fail('SOURCE_OBSERVATION_STALE');
    // Cancel late bind completion when this bounded observation times out.
    const bindingController = new AbortController();
    const abortBinding = () => bindingController.abort();
    signal?.addEventListener('abort', abortBinding, { once: true });
    if (signal?.aborted) abortBinding();
    try {
      await bounded(() => commandContext?.observe?.({ record, receipt, facts, current, signal: bindingController.signal }), signal, current);
    } finally { signal?.removeEventListener('abort', abortBinding); abortBinding(); }
    check(record, current, signal);
    if (epoch !== observationEpoch || unresolved.size || !authority.validate(receipt, { record })) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    lastObservedAt = facts.observedAt;
    if (noItem(facts) && !initialRecords.has(record))
      initialRecords.set(record, { signature: initialSignature(record), phase: 'ready' });
    identities.set(record, Object.freeze({ deviceId: facts.deviceId,
      ...(noItem(facts) ? { itemState: 'no-item' } : { trackId: facts.trackId }) }));
    const token = Object.freeze({});
    observations.set(token, { receipt, facts, stamp: saved.stamp, epoch,
      sourceSession: record.sourceSession, session: record.session, mutationEpoch: record.mutationEpoch });
    return token;
  }
  function known(token) {
    const saved = token && observations.get(token);
    if (closed || !saved || saved.epoch !== observationEpoch || unresolved.size
      || !sameStamp(saved.stamp, authority.stamp())) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    // Revocation remains owned by the authority; a cloned token or serialized record has no entry.
    if (!authority.validate(saved.receipt)) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    return saved.facts;
  }
  function describeState(token) {
    if (token === null) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    const facts = known(token);
    if (noItem(facts)) return { deviceId: facts.deviceId, itemState: 'no-item' };
    return { deviceId: facts.deviceId, trackId: facts.trackId, durationMs: facts.durationMs };
  }
  function initialNoItemFacts(token, expected) {
    const facts = known(token), owner = observations.get(token), initial = initialCurrent(expected);
    if (!noItem(facts) || initial.phase !== 'ready' || owner.sourceSession !== expected.sourceSession
      || owner.session !== expected.session || owner.mutationEpoch !== expected.mutationEpoch
      || facts.deviceId !== expected.deviceId) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    return Object.freeze({ ...facts });
  }
  function playbackFacts(token, expected, { matchTrack = true, allowInactive = false } = {}) {
    const facts = known(token);
    if (noItem(facts)) throw fail('TRACK_NOT_CURRENT');
    const owner = observations.get(token);
    if (owner.sourceSession !== expected.sourceSession || owner.session !== expected.session
      || owner.mutationEpoch !== expected.mutationEpoch) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    if (facts.deviceId !== expected.deviceId) throw fail('DEVICE_ID_MISMATCH');
    if (facts.isActive !== true && !(allowInactive && !matchTrack && facts.isActive === false && facts.isPlaying === false)) throw fail('DEVICE_INACTIVE');
    if (facts.restricted !== false) throw fail('DEVICE_RESTRICTED');
    if (typeof facts.isPlaying !== 'boolean' || !/^[A-Za-z0-9]{22}$/.test(facts.trackId)
      || !Number.isSafeInteger(facts.durationMs) || facts.durationMs < 1 || facts.durationMs > 3600000
      || !Number.isSafeInteger(facts.positionMs) || facts.positionMs < 0
      || facts.positionMs > facts.durationMs || facts.isPlaying && facts.positionMs === facts.durationMs) throw fail('PROTOCOL_INVALID');
    if (matchTrack && facts.trackId !== expected.trackId) throw fail('TRACK_NOT_CURRENT');
    if (matchTrack && Math.abs(facts.durationMs - expected.durationMs) > 1000) throw fail('PROTOCOL_INVALID');
    return Object.freeze({ ...facts, positionMs: matchTrack ? facts.positionMs : 0,
      disallows: Object.freeze({ ...facts.disallows }) });
  }
  async function invoke(command, record, current, options) {
    command = checkedCommand(command);
    check(record, current, options.signal);
    if (unresolved.size) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    const initial = noItem(identities.get(record)) ? initialCurrent(record) : null;
    const empty = initial !== null;
    if (empty && (initial.phase !== 'ready' || command.operation !== 'select' || options.positionMs > 0
      || typeof commandContext?.confirmSelected !== 'function')) throw fail('SOURCE_OPERATION_UNSUPPORTED');
    let expired = false;
    const emptyStartedAt = empty ? now() : 0, emptyDeadline = emptyStartedAt + timeoutMs;
    const checkEmptyWindow = () => {
      const time = now();
      if (expired || options.signal?.aborted || !Number.isSafeInteger(time)
        || time < emptyStartedAt || time >= emptyDeadline) throw fail('SOURCE_EFFECT_UNKNOWN');
    };
    // A private identity admission can carry forward without reusing playback
    // observations. A typed miss still needs a fresh qualified snapshot/bind.
    let reuse = false;
    if (typeof commandContext?.prepare === 'function') {
      const controller = new AbortController(), abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        reuse = await bounded(() => commandContext.prepare({ record, command,
          expected: options.expectedIdentity || identities.get(record), current, signal: controller.signal,
          ...(empty ? { deadline: emptyDeadline } : {}) }), options.signal, current);
      } finally { options.signal?.removeEventListener('abort', abort); abort(); }
      if (reuse !== true && reuse !== false) throw fail('SESSION_OBSERVATION_UNTRUSTED');
    }
    if (!reuse && (typeof commandContext?.prepare === 'function' || commandContext?.requiresPreDispatchObservation === true)) {
      await snapshot(record, current, options.signal, empty);
      check(record, current, options.signal);
      if (unresolved.size) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    }
    check(record, current, options.signal);
    if (unresolved.size) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    if (empty) {
      initialCurrent(record); checkEmptyWindow();
      if (!noItem(identities.get(record))) throw fail('SESSION_OBSERVATION_UNTRUSTED');
      initial.phase = 'attempted';
    }
    // This set retains the actual write beyond caller timeout/abort and across provider-track changes.
    const write = Object.freeze({ command, sourceSession: record.sourceSession, session: record.session });
    unresolved.add(write); observationEpoch++;
    let ticket, binding, pendingOwner;
    try {
      const expected = options.expectedIdentity || identities.get(record)
        || Object.freeze({ deviceId: record.deviceId, trackId: record.trackId });
      binding = commandContext?.bind({ record, command, expected, current, signal: options.signal,
        ...(empty ? { deadline: emptyDeadline } : {}) });
      ticket = port.request('command', binding ? binding.payload : { command }, { signal: options.signal,
      beforeDispatch() {
        check(record, current, options.signal); options.onDispatch?.(); check(record, current, options.signal);
        // A separate private, synchronous source binding check owns device/track/process/connection validity.
        // Account-vault stamps and raw Connect events cannot supply this contract.
        if (authority.assertDispatch({ record, command, expected }) !== undefined) throw fail('SESSION_OBSERVATION_UNTRUSTED');
        check(record, current, options.signal);
        binding?.assertCurrent();
        if (empty) checkEmptyWindow();
      },
      onDispatch() {
        pendingOwner = Object.freeze({ write, priorPending: record.mutationPending === true,
          sourceSession: record.sourceSession, session: record.session, stamp: { ...record.stamp } });
        mutationOwners.set(record, pendingOwner); record.mutationPending = true;
      } }); }
    catch (error) { binding?.release(); unresolved.delete(write); throw error; }
    void ticket.producer.finally(() => binding?.release()).catch(() => {});
    void ticket.result.catch(() => {});
    const completion = ticket.producer.then(async outcome => {
      // The wire's fulfilled/rejected/unknown strings can never clear the mutation barrier.
      const receipt = await authority.completeMutation({ write, outcome });
      if (!receipt || !authority.validate(receipt, { write, kind: 'quiescence' })) throw fail('SOURCE_EFFECT_UNKNOWN');
      if (empty) {
        checkEmptyWindow();
        // A synchronous return is usable only after the same private producer
        // has supplied the exact quiescence receipt above; return shape alone is unknown.
        if (!['fulfilled', 'returned'].includes(outcome?.call)) throw fail('SOURCE_EFFECT_UNKNOWN');
        const selected = await authority.snapshot({ record, allowInitialNoItem: false });
        const verified = authority.validate(selected, { record, kind: 'snapshot' });
        checkEmptyWindow();
        if (!verified || !sameStamp(verified.stamp, record.stamp)) throw fail('SOURCE_EFFECT_UNKNOWN');
        check(record, current, options.signal); initialCurrent(record);
        const confirmed = commandContext.confirmSelected({ record, receipt: selected, facts: copyData(verified.facts) });
        if (confirmed !== undefined) {
          if (confirmed && typeof confirmed.then === 'function') void Promise.resolve(confirmed).catch(() => {});
          throw fail('SOURCE_EFFECT_UNKNOWN');
        }
        check(record, current, options.signal); checkEmptyWindow(); initial.phase = 'selected';
      }
      if (typeof commandContext?.mutationCompleted === 'function') {
        const completed = commandContext.mutationCompleted({ record, command });
        if (completed !== undefined) {
          if (completed && typeof completed.then === 'function') void Promise.resolve(completed).catch(() => {});
          throw fail('SOURCE_EFFECT_UNKNOWN');
        }
      }
      unresolved.delete(write);
      if (pendingOwner && mutationOwners.get(record) === pendingOwner) mutationOwners.delete(record);
      return { acknowledgment: 'SOURCE_CALL_OBSERVED' };
    }, error => {
      if (!ticket.wasDispatched()) {
        unresolved.delete(write);
        // Exact private negative evidence may restore only this write's own
        // newly introduced marker, never earlier or newer pending work.
        if (pendingOwner && mutationOwners.get(record) === pendingOwner) {
          mutationOwners.delete(record);
          if (!pendingOwner.priorPending && record.mutationPending === true
            && record.sourceSession === pendingOwner.sourceSession && record.session === pendingOwner.session
            && sameStamp(record.stamp, pendingOwner.stamp)) record.mutationPending = false;
        }
      }
      throw error;
    });
    void completion.catch(() => {});
    return bounded(() => completion, options.signal, () => check(record, current, options.signal))
      .catch(async error => {
        if (empty) expired = true;
        // Retire exact never-attempted writes before controller cancellation
        // recovery reads both barriers, without waiting for abandoned crypto.
        if (!ticket.wasDispatched()) await completion.catch(() => {});
        throw error;
      });
  }
  async function request(operation, record, current, options = {}) {
    check(record, current, options.signal);
    if (operation === 'state') {
      if (options.allowInitialNoItem !== undefined && typeof options.allowInitialNoItem !== 'boolean') throw fail('PROTOCOL_INVALID');
      return snapshot(record, current, options.signal, options.allowInitialNoItem === true);
    }
    if (operation === 'devices') {
      const receipt = await bounded(() => authority.devices({ record }), options.signal, current);
      const verified = authority.validate(receipt, { record, kind: 'devices' });
      check(record, current, options.signal);
      if (!verified || !sameStamp(verified.stamp, record.stamp)) throw fail('SESSION_OBSERVATION_UNTRUSTED');
      return copyData(verified.inventory);
    }
    if (!['select', 'play', 'pause', 'seek', 'play-at-position'].includes(operation)) throw fail('SOURCE_OPERATION_UNSUPPORTED');
    if (options.beforeDispatch != null) {
      if (operation !== 'play-at-position' || typeof options.beforeDispatch !== 'function') throw fail('PROTOCOL_INVALID');
      await bounded(options.beforeDispatch, options.signal, current); check(record, current, options.signal);
    }
    const originalDispatch = options.onDispatch; let notified = false;
    options = { ...options, onDispatch() { if (!notified) { originalDispatch?.(); notified = true; } } };
    if (operation === 'select') {
      await invoke({ operation: 'select', args: { uri: `spotify:track:${record.trackId}` } }, record, current, options);
      if (options.positionMs > 0) return invoke({ operation: 'seek', args: { positionMs: options.positionMs, durationMs: record.durationMs } }, record, current,
        { ...options, expectedIdentity: { deviceId: record.deviceId, trackId: record.trackId } });
      return { acknowledgment: 'SOURCE_CALL_OBSERVED' };
    }
    if (operation === 'play-at-position') {
      await invoke({ operation: 'seek', args: { positionMs: options.positionMs, durationMs: record.durationMs } }, record, current, options);
      return invoke({ operation: 'resume', args: {} }, record, current, options);
    }
    return invoke({ operation: operation === 'play' ? 'resume' : operation,
      args: operation === 'seek' ? { positionMs: options.positionMs, durationMs: record.durationMs } : {} }, record, current, options);
  }
  return Object.freeze({ authorize, request, describeState, initialNoItemFacts, playbackFacts, hasUnsettledWrites: () => unresolved.size > 0,
    start: () => port.request('start').result,
    close() { if (closed) return; closed = true; observationEpoch++; detach(); port.close(); },
    inspect: () => ({ closed, unknownWrites: unresolved.size, observationEpoch, lastDiagnostic,
      evidenceOrigin: 'private-source-capability', transportAuthentication: 'in-process-pair-only' }),
  });
}
module.exports = { createSourceCore };
