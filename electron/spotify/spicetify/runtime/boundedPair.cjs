'use strict';

// runtime/boundedPair.cjs: bounded, explicitly paired process capabilities; no sockets or ambient discovery.
const fail = code => Object.assign(new Error(code), { code });
function copyData(value, limit = 32768) {
  let budget = 2048, bytes = 0;
  function charge(value) { bytes += typeof value === 'string' ? Buffer.byteLength(value) : 8; if (bytes > limit) throw fail('BRIDGE_FRAME_TOO_LARGE'); }
  function visit(node, depth) {
    if (--budget < 0 || depth > 12) throw fail('BRIDGE_FRAME_INVALID');
    charge(typeof node === 'string' ? node : 0);
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node === 'string' && node.length <= limit) return node;
    if (!node || typeof node !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(node)))
      throw fail('BRIDGE_FRAME_INVALID');
    const array = Array.isArray(node), keys = Reflect.ownKeys(node);
    if (keys.length > 2048 || array && (node.length > 2048 || keys.length !== node.length + 1)) throw fail('BRIDGE_FRAME_INVALID');
    const result = array ? [] : Object.create(null);
    for (const key of keys) {
      if (Array.isArray(node) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('BRIDGE_FRAME_INVALID');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length)) throw fail('BRIDGE_FRAME_INVALID');
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail('BRIDGE_FRAME_INVALID');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > limit) throw fail('BRIDGE_FRAME_TOO_LARGE');
  return result;
}
function createBoundedPair({ maxPending = 8, maxEvents = 32, timeoutMs = 1000, schedule = queueMicrotask } = {}) {
  if (![maxPending, maxEvents, timeoutMs].every(Number.isSafeInteger) || maxPending < 1 || maxPending > 32
    || maxEvents < 1 || maxEvents > 128 || timeoutMs < 1 || timeoutMs > 10000 || typeof schedule !== 'function') throw fail('BRIDGE_CONFIG_INVALID');
  let closed = false, serial = 0, epoch = 1, handler = null, subscriber = null, eventScheduled = false;
  const active = new Set(), events = [];
  const closeListeners = new Set();
  function onClose(listener) {
    if (closed || typeof listener !== 'function' || closeListeners.size >= 8) throw fail('BRIDGE_SUBSCRIPTION_INVALID');
    closeListeners.add(listener); return () => closeListeners.delete(listener);
  }
  function request(operation, payload = {}, { signal, beforeDispatch, onDispatch } = {}) {
    if (closed) throw fail('BRIDGE_CLOSED');
    if (!['command', 'snapshot', 'start', 'stop'].includes(operation)) throw fail('BRIDGE_OPERATION_DENIED');
    if (beforeDispatch != null && typeof beforeDispatch !== 'function' || onDispatch != null && typeof onDispatch !== 'function') throw fail('BRIDGE_CONFIG_INVALID');
    if (active.size >= maxPending) throw fail('BRIDGE_BACKPRESSURE');
    const frame = Object.freeze({ id: ++serial, epoch, operation, payload: copyData(payload) });
    let resolveResult, rejectResult, resolveProducer, rejectProducer;
    const result = new Promise((yes, no) => { resolveResult = yes; rejectResult = no; });
    const producer = new Promise((yes, no) => { resolveProducer = yes; rejectProducer = no; });
    // A caller may inspect only the bounded result; retain observed rejection independently.
    void producer.catch(() => {});
    const record = { done: false, dispatched: false, rejectResult, timer: null, abort: null };
    function finish(error, value) {
      if (record.done) return;
      record.done = true; clearTimeout(record.timer); signal?.removeEventListener('abort', record.abort);
      // A queued request owns no producer. Its cancellation also settles that zero-effect lifetime.
      if (error && !record.dispatched) { active.delete(record); rejectProducer(error); }
      if (error) rejectResult(error); else resolveResult(value);
    }
    record.abort = () => finish(fail('CANCELLED'));
    record.finish = finish;
    record.timer = setTimeout(() => finish(fail('CONTROL_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', record.abort, { once: true });
    active.add(record);
    const refuse = error => { active.delete(record); finish(error); rejectProducer(error); };
    const ticket = Object.freeze({ result, producer, wasDispatched: () => record.dispatched });
    if (signal?.aborted) { refuse(fail('CANCELLED')); return ticket; }
    try { schedule(() => {
      if (closed || frame.epoch !== epoch || record.done) { refuse(fail(closed ? 'BRIDGE_CLOSED' : 'CANCELLED')); return; }
      if (!handler) { refuse(fail('BRIDGE_UNPAIRED')); return; }
      // Actual handler lifetime survives result cancellation, disconnect and timeout.
      Promise.resolve().then(() => {
        if (closed || frame.epoch !== epoch || record.done) throw fail('CANCELLED');
        const commit = () => {
          if (closed || frame.epoch !== epoch || record.done || signal?.aborted) throw fail('CANCELLED');
          beforeDispatch?.();
          if (closed || frame.epoch !== epoch || record.done || signal?.aborted) throw fail('CANCELLED');
          record.dispatched = true;
          onDispatch?.();
        };
        if (operation !== 'command') commit();
        // The fixed desktop endpoint commits after resolving every PlayerAPI accessor, immediately before invocation.
        return handler(frame, Object.freeze({ commit }));
      }).then(value => {
        let receipt;
        try { receipt = copyData(value); } catch (error) { finish(error); rejectProducer(error); active.delete(record); return; }
        active.delete(record); resolveProducer(receipt);
        if (closed || frame.epoch !== epoch) finish(fail('BRIDGE_CLOSED')); else finish(null, receipt);
      }, error => { active.delete(record); const safe = fail(['CANCELLED', 'OPERATION_DENIED', 'SESSION_CHANGED', 'STALE_SESSION', 'CLOSED',
        'DEVICE_ID_MISMATCH', 'TRACK_NOT_CURRENT', 'SPOTIFY_INSTANCE_CHANGED', 'SESSION_OBSERVATION_UNTRUSTED'].includes(error?.code) ? error.code : 'BRIDGE_PRODUCER_FAILED'); finish(safe); rejectProducer(safe); });
    }); } catch { refuse(fail('BRIDGE_SCHEDULE_FAILED')); }
    return ticket;
  }
  function publish(value) {
    if (closed) return false;
    const frame = copyData(value);
    if (events.length >= maxEvents) { close('BRIDGE_EVENT_OVERFLOW'); return false; }
    events.push({ epoch, frame });
    if (!eventScheduled) {
      eventScheduled = true;
      try { schedule(() => {
        eventScheduled = false;
        while (!closed && events.length) {
          const next = events.shift();
          if (next.epoch === epoch) { try { subscriber?.(next.frame); } catch { close('BRIDGE_EVENT_CONSUMER_FAILED'); } }
        }
      }); } catch { close('BRIDGE_SCHEDULE_FAILED'); }
    }
    return true;
  }
  function close(code = 'BRIDGE_CLOSED') {
    if (closed) return;
    closed = true; epoch++; events.length = 0; subscriber = null;
    for (const record of active) record.finish(fail(code));
    for (const listener of [...closeListeners]) { try { listener(code); } catch { /* Closing is irreversible; every listener still gets its cleanup opportunity. */ } }
    closeListeners.clear();
  }
  return Object.freeze({
    main: Object.freeze({ request, subscribe(fn) { if (closed || subscriber || typeof fn !== 'function') throw fail('BRIDGE_SUBSCRIPTION_INVALID'); subscriber = fn; return () => { if (subscriber === fn) subscriber = null; }; }, onClose, close }),
    desktop: Object.freeze({ bind(fn) { if (closed || handler || typeof fn !== 'function') throw fail('BRIDGE_PAIR_INVALID'); handler = fn; }, publish, onClose, close }),
    inspect: () => Object.freeze({ closed, pending: active.size, queuedEvents: events.length, epoch }),
  });
}
module.exports = { createBoundedPair, copyData };
