const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSoloistAuthReadObserver } = require('../../electron/spotify/soloistAuthReadObserver.cjs');
const { projectSoloistAuthDiagnostic } = require('../../electron/spotify/soloistAuthDiagnostics.cjs');

// Synthetic promises and schema fixtures only; this observer never performs a read.
const tick = () => new Promise(resolve => setImmediate(resolve));
const diagnostic = () => ({ stage: 'initial-auth', reason: 'frame-type', frameType: 'CLOSED', topLevelType: 'missing',
  eventType: 'missing', loggedInType: 'missing', isActiveType: 'missing', closeCode: 1006 });
test('observing preserves the original Promise result error receiver and arguments with exactly one read', async () => {
  const rows = [], options = { signal: new AbortController().signal };
  const result = { authState: { logged_in: true, is_active: false }, account: 'private-account', token: 'private-token' };
  const pending = Promise.resolve(result); let reads = 0;
  const original = { readFresh(...args) { reads++; assert.equal(this, original); assert.deepEqual(args, [options]); return pending; } };
  const observer = createSoloistAuthReadObserver({ onObservation: row => rows.push(row) });
  const readFresh = observer.wrap(original.readFresh), received = readFresh.call(original, options);
  assert.equal(received, pending); assert.equal(await received, result); assert.equal(reads, 1); await tick();
  assert.equal(rows.length, 2); assert.deepEqual(rows[0], { observation: 1, stage: 'read', phase: 'request' });
  assert.equal(rows[1].ok, true); assert.equal(rows[1].authenticated, true); assert.equal(rows[1].active, false);
  assert.equal(Object.isFrozen(rows[1]), true); assert.equal(JSON.stringify(rows).includes('private'), false);
  const error = Object.assign(Error('private failure payload'), { code: 'AUTH_SCHEMA_INVALID' });
  Object.defineProperty(error, 'diagnostic', { value: Object.freeze(diagnostic()) });
  const rejected = Promise.reject(error);
  assert.equal(observer.observe(rejected), rejected); await assert.rejects(rejected, value => value === error); await tick();
  assert.equal(rows.at(-1).errorCode, 'AUTH_SCHEMA_INVALID'); assert.equal(rows.at(-1).frameType, 'CLOSED');
  assert.equal(rows.at(-1).stage, 'initial-auth'); assert.equal(JSON.stringify(rows).includes('private'), false);
});
test('default observation cap is 160 while explicit continuous mode streams later reads with bounded retained history', async () => {
  for (const continuous of [false, true]) {
    const rows = [], observer = createSoloistAuthReadObserver({ continuous, onObservation: row => rows.push(row), now: () => 10 });
    let reads = 0;
    const read = observer.wrap(() => { reads++; return Promise.resolve({ authState: { logged_in: false, is_active: false } }); });
    for (let index = 0; index < 170; index++) await read();
    assert.equal(reads, 170); assert.equal(rows.length, (continuous ? 170 : 160) * 2);
    const snapshot = observer.snapshot(); assert.equal(snapshot.length, 160); assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(snapshot[0].observation, continuous ? 11 : 1); assert.equal(snapshot.at(-1).observation, continuous ? 170 : 160);
    assert.equal(snapshot.every(row => Object.isFrozen(row) && row.phase === 'result'), true);
  }
});
test('throwing and rejecting sinks clocks and data accessors cannot replace a successful or failed read', async () => {
  let getters = 0;
  const payload = Object.defineProperty({}, 'authState', { get() { getters++; throw Error('private'); } });
  for (const onObservation of [() => { throw Error('private'); }, () => Promise.reject(Error('private'))]) {
    const observer = createSoloistAuthReadObserver({ onObservation, now: () => { throw Error('clock'); } });
    const pending = Promise.resolve(payload); assert.equal(observer.observe(pending), pending); assert.equal(await pending, payload);
    const error = Object.defineProperty(Error('private'), 'code', { get() { getters++; throw Error('private'); } });
    const rejected = Promise.reject(error); assert.equal(observer.observe(rejected), rejected);
    await assert.rejects(rejected, value => value === error); await tick();
    assert.equal(observer.snapshot().at(-1).errorCode, 'UNKNOWN');
  }
  assert.equal(getters, 0);
});
test('synchronous results and throws are returned unchanged and unknown diagnostic metadata is never copied', async () => {
  const rows = [], observer = createSoloistAuthReadObserver({ onObservation: row => rows.push(row) });
  const value = { authState: { logged_in: 'private-token', is_active: 1 } };
  assert.equal(observer.wrap(() => value)(), value); await tick();
  assert.equal(Object.hasOwn(rows.at(-1), 'authenticated'), false); assert.equal(Object.hasOwn(rows.at(-1), 'active'), false);
  const error = Object.assign(Error('private'), { code: 'PRIVATE_TOKEN', diagnostic: diagnostic() });
  assert.throws(observer.wrap(() => { throw error; }), value => value === error);
  assert.equal(rows.at(-1).errorCode, 'UNKNOWN'); assert.equal(Object.hasOwn(rows.at(-1), 'frameType'), false);
  const malformed = Object.assign(Error('private'), { code: 'AUTH_SCHEMA_INVALID', diagnostic: { ...diagnostic(), raw: 'private' } });
  const rejected = Promise.reject(malformed); observer.observe(rejected); await assert.rejects(rejected, value => value === malformed); await tick();
  assert.equal(rows.at(-1).errorCode, 'AUTH_SCHEMA_INVALID'); assert.equal(Object.hasOwn(rows.at(-1), 'frameType'), false);
  assert.equal(JSON.stringify(rows).includes('private'), false);
});
test('diagnostic projection does not evaluate accessors or retain caller object identity', () => {
  let getters = 0;
  const input = diagnostic(), projected = projectSoloistAuthDiagnostic(input);
  assert.notEqual(projected, input); input.closeCode = 99999; assert.equal(projected.closeCode, 1006);
  Object.defineProperty(input, 'stage', { enumerable: true, get() { getters++; return 'initial-auth'; } });
  assert.equal(projectSoloistAuthDiagnostic(input), null); assert.equal(getters, 0);
});
