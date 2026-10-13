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


module.exports = { fixture, TRACK, OTHER, SESSION, fail };
