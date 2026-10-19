'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const application = process.env.FOLIA_CONTROL_TEST_APP || path.resolve(__dirname, '../../..');
const { createDesktopPlaybackControl } = require(path.join(application, 'electron/spotify/desktopPlaybackControl.cjs'));

// Actual production controller/API with synthetic official responses and explicit native-proof callbacks; no account or Windows access.
const TRACK = '3n3Ppam7vgaVa1iaRUc9Lp', OTHER = '4n4Qqam7vgaVa1iaRUc9Lp';
const SESSION = '12345678-1234-1234-1234-123456789abc';
const fail = code => Object.assign(new Error(code), { code });

function fixture(options = {}) {
  let clock = 10000, revision = 0, selected = options.warm === true;
  const events = [], observations = [], hooks = {};
  const device = { id: 'synthetic-desktop', type: 'computer', is_active: selected, is_restricted: false };
  const state = { device, item: { type: 'track', uri: `spotify:track:${selected ? OTHER : TRACK}`, duration_ms: 120000 },
    currently_playing_type: 'track', is_playing: false, progress_ms: 0, actions: { disallows: {} } };
  const vault = { stamp: () => ({ epoch: 0, revision }), token: async () => 'synthetic-not-a-credential',
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const fetcher = async (address, init) => {
    const url = new URL(address);
    const operation = init.method === 'GET' ? url.pathname.endsWith('/devices') ? 'devices' : 'state'
      : url.pathname.endsWith('/play') ? init.body ? 'select' : 'play' : url.pathname.endsWith('/pause') ? 'pause' : 'seek';
    events.push(operation); clock += init.method === 'GET' ? options.getMs ?? 10 : options.putMs ?? 10;
    if (state.is_playing) state.progress_ms += init.method === 'GET' ? options.getMs ?? 10 : options.putMs ?? 10;
    const overridden = await hooks.http?.({ operation, state, init, url });
    if (overridden) return overridden;
    if (operation === 'devices') return Response.json({ devices: [device] });
    if (operation === 'state') return selected ? Response.json(state) : new Response(null, { status: 204 });
    assert.equal(url.searchParams.get('device_id'), device.id);
    if (operation === 'select') {
      selected = true; device.is_active = true; state.is_playing = true;
      const body = JSON.parse(init.body); state.item.uri = body.uris[0]; state.progress_ms = body.position_ms;
    } else if (operation === 'pause') state.is_playing = false;
    else if (operation === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
    else if (operation === 'play') state.is_playing = true;
    return new Response(options.response200 ? 'opaque acknowledgment' : null, { status: options.response200 ? 200 : 204 });
  };
  const control = createDesktopPlaybackControl({ vault, cooldown: { load: async () => 0, defer: async () => 0 },
    fetcher, now: () => clock, wait: async ms => { clock += ms; }, settleTimeoutMs: 4000, settleIntervalMs: 40,
    readRoutePcmEvidence: (session, generation) => session === SESSION && generation === 1 });
  async function proof(phase, expected = TRACK) {
    const result = await control.routeSourceControl({ session: SESSION, generation: 1, action: 'read',
      sourceDeviceId: device.id, expectedSourceUri: `spotify:track:${expected}`, requirePreparationObservation: true,
      preparationPhase: phase, requirePreparedSelection: true, preparationSelectedSourceUri: `spotify:track:${TRACK}` });
    observations.push(result); return result;
  }
  const prepare = extra => control.prepare({ session: SESSION, deviceId: device.id, trackId: TRACK,
    durationMs: 120000, restoreSavedTarget: true, coldBootstrapRequired: !options.warm, coldBootstrap: async facts => {
      events.push('inspect'); await hooks.inspect?.(facts);
    }, routedPreparation: {
      beforeSelect: async paused => { events.push('acquire'); await proof('baseline', paused.trackId); await hooks.acquire?.(); },
      afterSelect: async selected => { events.push('target-active'); await hooks.targetActive?.(selected); },
      afterPark: async () => { events.push('complete'); await proof('selected'); },
    }, ...extra });
  return { control, prepare, state, events, observations, hooks, proof, now: () => clock,
    advance: ms => { clock += ms; }, changeGrant: () => { revision++; } };
}

test('cold discovery waits for a native session before pause, then route-bound selection proves target activity', async () => {
  const f = fixture();
  try {
    f.hooks.inspect = facts => {
      assert.equal(facts.isPlaying, f.state.is_playing);
    };
    await f.prepare();
    assert.deepEqual(f.events, ['devices', 'state', 'select', 'state', 'inspect', 'pause', 'state',
      'inspect', 'acquire', 'select', 'state', 'target-active', 'pause', 'state', 'seek', 'state', 'complete']);
    assert.equal(f.events.filter(value => value === 'select').length, 2);
    assert.ok(f.observations[1].observationGeneration > f.observations[0].observationGeneration);
    assert.ok(f.observations[1].mutationEpoch > f.observations[0].mutationEpoch);
  } finally { await f.control.dispose(); }
});

test('unknown select/pause/seek 200 responses still receive their own post-write observations', async () => {
  const f = fixture({ response200: true });
  try {
    await f.prepare();
    for (const operation of ['select', 'pause', 'seek']) {
      const index = f.events.indexOf(operation); assert.equal(f.events[index + 1], 'state');
    }
    assert.ok(f.events.indexOf('inspect') < f.events.indexOf('pause'));
    assert.ok(f.events.lastIndexOf('inspect') > f.events.indexOf('pause'));
  } finally { await f.control.dispose(); }
});

test('native baseline rereads reuse the original actual observation without extending its timestamp', async () => {
  const f = fixture();
  try {
    let parkedAt;
    f.hooks.inspect = facts => { parkedAt = facts.observedAt; f.advance(300); };
    f.hooks.acquire = async () => {
      const initial = f.observations.at(-1), count = f.events.filter(value => value === 'state').length;
      f.advance(100); const again = await f.proof('baseline');
      assert.deepEqual(again, initial); assert.equal(Date.parse(again.observedAtUtc), parkedAt);
      assert.equal(f.events.filter(value => value === 'state').length, count);
    };
    await f.prepare();
  } finally { await f.control.dispose(); }
});

test('a cold receipt aged during acquisition cannot discharge the formal selection', async () => {
  const f = fixture();
  try {
    f.hooks.acquire = () => f.advance(5000);
    await f.prepare();
    assert.equal(f.events.filter(value => value === 'select').length, 2);
  } finally { await f.control.dispose(); }
});

test('a native inspection failure leaves the exact source paused and never acquires a route', async () => {
  const f = fixture();
  try {
    f.hooks.inspect = () => { throw fail('SPOTIFY_AUDIO_PROCESS_AMBIGUOUS'); };
    await assert.rejects(f.prepare(), { code: 'SPOTIFY_AUDIO_PROCESS_AMBIGUOUS' });
    assert.equal(f.state.is_playing, false);
    assert.equal(f.events.includes('acquire'), false);
    assert.equal(f.events.filter(value => value === 'pause').length, 1);
  } finally { await f.control.dispose(); }
});

test('missing native session retries while selected playback can materialize it without another play/select', async () => {
  const f = fixture();
  try {
    let attempts = 0;
    f.hooks.inspect = facts => { attempts++; assert.equal(facts.isPlaying, true); throw fail('EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN'); };
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_IDENTITY_UNCONFIRMED' });
    assert.ok(attempts > 1); assert.equal(f.events.includes('acquire'), false);
    assert.equal(f.events.filter(value => value === 'select').length, 1);
    assert.equal(f.events.includes('play'), false); assert.equal(f.state.is_playing, false);
  } finally { await f.control.dispose(); }
});

test('cold no-session followed by incomplete discovery cleans up before a fresh preparation can succeed',async()=>{
 const {retryPlayback}=require('../../../electron/spotify/playbackRetry.cjs');
 const f=fixture();let inspections=0,attempts=0;
 f.hooks.inspect=facts=>{
  inspections++;
  if(inspections===1)throw fail('EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN');
  if(inspections===2)throw Object.assign(fail('COMPLETE_SPOTIFY_DISCOVERY_REQUIRED'),{stage:'route-inspect'});
 };
 try{
  await retryPlayback(async()=>{
   attempts++;
   if(attempts===2){assert.equal(f.state.is_playing,false);assert.equal(f.events.includes('acquire'),false);}
   return f.prepare();
  },{wait:async()=>{}});
  assert.equal(attempts,2);assert.equal(f.events.filter(event=>event==='acquire').length,1);
  assert.equal(f.events.filter(event=>event==='complete').length,1);assert.equal(f.state.is_playing,false);
 }finally{await f.control.dispose();}
});

test('cancellation during paused inspection never grants route or selection authority', async () => {
  const f = fixture(), abort = new AbortController();
  try {
    f.hooks.inspect = facts => { if (!facts.isPlaying) abort.abort(); };
    await assert.rejects(f.prepare({ signal: abort.signal }));
    assert.equal(f.events.includes('acquire'), false); assert.equal(f.state.is_playing, false);
  } finally { await f.control.dispose(); }
});

test('account generation change during paused inspection cannot reuse that receipt', async () => {
  const f = fixture();
  try {
    f.hooks.inspect = facts => { if (!facts.isPlaying) f.changeGrant(); };
    await assert.rejects(f.prepare(), { code: 'SESSION_CHANGED' });
    assert.equal(f.events.includes('acquire'), false); assert.equal(f.state.is_playing, false);
  } finally { await f.control.dispose(); }
});

test('a wrong pause 204 cannot authorize a paused inspection or acquisition', async () => {
  const f = fixture();
  try {
    f.hooks.http = ({ operation }) => operation === 'pause' ? new Response(null, { status: 204 }) : undefined;
    await assert.rejects(f.prepare());
    assert.equal(f.events.filter(value => value === 'inspect').length, 1); assert.equal(f.events.includes('acquire'), false);
  } finally { await f.control.dispose(); }
});

test('a changed track after cold inspection is rejected before selection completion or capture', async () => {
  const f = fixture();
  try {
    f.hooks.inspect = () => { f.state.item.uri = `spotify:track:${OTHER}`; };
    await assert.rejects(f.prepare(), { code: 'TRACK_NOT_CURRENT' });
    assert.equal(f.events.includes('complete'), false);
    assert.equal(f.events.filter(value => value === 'select').length, 1);
  } finally { await f.control.dispose(); }
});

test('a new native generation cannot consume a preparation lease already bound to its predecessor', async () => {
  const f = fixture();
  try {
    f.hooks.acquire = async () => {
      await assert.rejects(f.control.routeSourceControl({ session: SESSION, generation: 2, action: 'read',
        sourceDeviceId: f.state.device.id, expectedSourceUri: `spotify:track:${TRACK}`,
        requirePreparationObservation: true, preparationPhase: 'baseline' }), { code: 'STALE_SESSION' });
    };
    await f.prepare();
  } finally { await f.control.dispose(); }
});

test('the existing warm per-write state gates account for four PUTs and six GETs through source resume', async () => {
  const f = fixture({ warm: true, getMs: 450, putMs: 650 });
  try {
    const startedAt = f.now(); await f.prepare(); await f.control.play(SESSION);
    assert.deepEqual(f.events, ['devices', 'state', 'acquire', 'select', 'state', 'target-active', 'pause', 'state', 'seek', 'state', 'complete', 'play', 'state']);
    assert.equal(f.now() - startedAt, 4 * 650 + 6 * 450);
    assert.equal(f.events.includes('inspect'), false);
  } finally { await f.control.dispose(); }
});

test('cold endpoint rejection preserves the actual route error through controller cleanup and recovery', async () => {
 const {prepareWithOrphanRecovery}=require('../../../electron/spotify/orphanRouteRecovery.cjs');
 const f=fixture();let inspections=0,recoveries=0;
 f.hooks.inspect=()=>{if(++inspections===1)throw fail('EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN');if(inspections===2)throw Object.assign(fail('ORIGINAL_ENDPOINT_UNSAFE'),{nativeCode:'ORIGINAL_ENDPOINT_UNSAFE',stage:'route-inspect'});};
 try{
  await prepareWithOrphanRecovery(()=>f.prepare(),async()=>{recoveries++;assert.equal(f.state.is_playing,false);assert.equal(f.events.includes('acquire'),false);});
  assert.equal(recoveries,1);assert.ok(f.events.includes('complete'));
 }finally{await f.control.dispose();}
});
