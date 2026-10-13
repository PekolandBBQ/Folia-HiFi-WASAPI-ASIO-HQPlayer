
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, SESSION, fail } = require('./preparedTargetFixture.cjs');

// Production controller with explicit native activity hook; all source responses are synthetic.
const turn = () => new Promise(resolve => setImmediate(resolve));
test('warm selection waits for native target activity before pause without adding a Spotify GET', async () => {
  const f = fixture({ warm: true }); let resolve, entered = false;
  f.hooks.targetActive = selected => { entered = true; assert.equal(selected.isPlaying, true);
    return new Promise(done => { resolve = done; }); };
  try {
    const task = f.prepare(); while (!entered) await turn();
    assert.equal(f.events.includes('pause'), false); assert.equal(f.events.includes('complete'), false);
    assert.deepEqual(f.events, ['devices', 'state', 'acquire', 'select', 'state', 'target-active']);
    resolve(); await task;
    assert.ok(f.events.indexOf('target-active') < f.events.indexOf('pause'));
    assert.equal(f.events.filter(value => value === 'state').length, 4);
  } finally { await f.control.dispose(); }
});
test('cold identity receipt cannot bypass post-route stream materialization', async () => {
  const f = fixture(); try {
    await f.prepare(); const route = f.events.indexOf('acquire'), witness = f.events.indexOf('target-active');
    assert.equal(f.events.filter(value => value === 'select').length, 2);
    assert.ok(f.events.lastIndexOf('select') > route && witness > f.events.lastIndexOf('select'));
    assert.ok(f.events.lastIndexOf('pause') > witness);
  } finally { await f.control.dispose(); }
});
for (const code of ['SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET', 'SESSION_OBSERVATION_UNTRUSTED', 'EXTERNAL_POLICY_CONFLICT'])
test('native ' + code + ' retains incomplete preparation and never completes capture preparation', async () => {
  const f = fixture({ warm: true }); f.hooks.targetActive = () => { throw fail(code); };
  try {
    await assert.rejects(f.prepare(), { code });
    assert.equal(f.events.includes('complete'), false); assert.equal(f.events.filter(value => value === 'select').length, 1);
    // The route owner remains responsible for exact-source pause before restoring its policy.
    assert.equal(f.state.is_playing, true);
  } finally { await f.control.dispose(); }
});
test('late witness reply after cancellation cannot complete preparation', async () => {
  const f = fixture({ warm: true }), abort = new AbortController(); let resolve, entered = false;
  f.hooks.targetActive = () => { entered = true; return new Promise(done => { resolve = done; }); };
  try {
    const result = f.prepare({ signal: abort.signal }).then(() => null, error => error);
    while (!entered) await turn(); abort.abort(); resolve();
    assert.ok(await result); assert.equal(f.events.includes('complete'), false);
  } finally { await f.control.dispose(); }
});
test('account change while native witness is pending cannot complete preparation', async () => {
  const f = fixture({ warm: true }); f.hooks.targetActive = f.changeGrant;
  try { await assert.rejects(f.prepare(), { code: 'SESSION_CHANGED' }); assert.equal(f.events.includes('complete'), false); }
  finally { await f.control.dispose(); }
});
test('missing native target hook fails closed before source writes', async () => {
  const f = fixture({ warm: true });
  try { await assert.rejects(f.prepare({ routedPreparation: { beforeSelect: async () => {}, afterPark: async () => {} } }), { code: 'PROTOCOL_INVALID' });
    assert.equal(f.events.includes('select'), false); }
  finally { await f.control.dispose(); }
});

test('failed target activity parks the exact selected source before reporting route cleanup readiness', async () => {
  const f = fixture({ warm: true }); let parked = false;
  f.hooks.targetActive = () => { throw fail('SESSION_OBSERVATION_UNTRUSTED'); };
  try {
    await assert.rejects(f.prepare({ onRouteParked: () => { parked = true; assert.equal(f.state.is_playing, false); } }),
      { code: 'SESSION_OBSERVATION_UNTRUSTED' });
    assert.equal(parked, true); assert.equal(f.state.is_playing, false);
    assert.equal(f.events.includes('complete'), false); assert.equal(f.events.filter(value => value === 'select').length, 1);
    assert.ok(f.events.indexOf('pause') > f.events.indexOf('target-active'));
  } finally { await f.control.dispose(); }
});
