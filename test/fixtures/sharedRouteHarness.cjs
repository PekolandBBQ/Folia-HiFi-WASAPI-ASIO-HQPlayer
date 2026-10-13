'use strict';
const { EventEmitter } = require('node:events');
const { createBoundedPair } = require('../../electron/spotify/spicetify/runtime/boundedPair.cjs');
const { createDesktopEndpoint } = require('../../electron/spotify/spicetify/runtime/desktopEndpoint.cjs');
const { createSourceCore } = require('../../electron/spotify/spicetify/runtime/sourceCore.cjs');

// test/fixtures/sharedRouteHarness.cjs: synthetic source contract for the existing real-controller/native-owner fixture.
function createSharedRouteHarness({ state, vault, now, events }) {
  const receipts = new WeakMap(), emitter = new EventEmitter(), calls = [], producers = new Map();
  let serial = 0, sourceEpoch = 0, complete = true, delayNext = null, processCurrent = true, connected = true;
  const currentState = () => JSON.stringify({ device: state.device, item: state.item,
    position: state.progress_ms, playing: state.is_playing, sourceEpoch });
  const player = { _events: emitter };
  const raw = () => ({ item: { uri: state.item.uri }, isPaused: !state.is_playing,
    positionAsOfTimestamp: state.progress_ms, duration: state.item.duration_ms, timestamp: sourceEpoch });
  Object.defineProperty(player, '_state', { get: raw });
  async function apply(operation, args) {
    const id = ++serial, pending = { settled: false }; producers.set(id, pending);
    calls.push({ id, operation, args }); events.push(`control:${operation}`); sourceEpoch++;
    if (delayNext) { const gate = delayNext; delayNext = null; await gate; }
    if (operation === 'pause') state.is_playing = false;
    if (operation === 'play') state.is_playing = true;
    if (operation === 'seek') state.progress_ms = args[0];
    if (operation === 'select') { state.item.uri = args[0].uri; state.progress_ms = 0; state.is_playing = true; state.device.is_active = true; }
    pending.settled = true; emitter.emit('update', { data: raw() });
  }
  Object.assign(player, { pause: (...args) => apply('pause', args), resume: (...args) => apply('play', args),
    seekTo: (...args) => apply('seek', args), play: (...args) => apply('select', args) });
  function remember(value) { const token = Object.freeze({}); receipts.set(token, { ...value,
    stamp: { ...vault.stamp() }, state: currentState() }); return token; }
  const authority = {
    stamp: vault.stamp, authorize: async () => ({ ...vault.stamp() }),
    assertDispatch({ expected }) {
      const fail = code => { throw Object.assign(new Error(code), { code }); };
      if (!connected || !processCurrent) fail('SPOTIFY_INSTANCE_CHANGED');
      if (state.device.id !== expected.deviceId) fail('DEVICE_ID_MISMATCH');
      if (state.item.uri !== `spotify:track:${expected.trackId}`) fail('TRACK_NOT_CURRENT');
    },
    snapshot: async () => {
      events.push('source:snapshot'); events.push(`observed:${state.is_playing ? 'playing' : 'paused'}`);
      return remember({ kind: 'snapshot', facts: { deviceId: state.device.id, trackId: state.item.uri.slice(14),
        positionMs: state.progress_ms, durationMs: state.item.duration_ms, isPlaying: state.is_playing,
        isActive: state.device.is_active, restricted: state.device.is_restricted, observedAt: now(),
        serverTimestamp: sourceEpoch, disallows: { pausing: false, resuming: false, seeking: false } } });
    },
    devices: async () => remember({ kind: 'devices', inventory: { devices: [structuredClone(state.device)] } }),
    completeMutation: async ({ write, outcome }) => {
      if (!complete || outcome.call !== 'fulfilled' || producers.get(outcome.commandId)?.settled !== true)
        throw Object.assign(new Error('SOURCE_EFFECT_UNKNOWN'), { code: 'SOURCE_EFFECT_UNKNOWN' });
      return remember({ kind: 'quiescence', write });
    },
    validate(token, expected) {
      const value = receipts.get(token), stamp = vault.stamp();
      if (!value || value.stamp.epoch !== stamp.epoch || value.stamp.revision !== stamp.revision
        || value.state !== currentState() || expected?.kind && value.kind !== expected.kind
        || expected?.write && value.write !== expected.write) return null;
      return value;
    },
  };
  const pair = createBoundedPair({ timeoutMs: 500 }), endpoint = createDesktopEndpoint({ port: pair.desktop,
    getPlayerAPI: () => player, getConnectAPI: () => ({ state: { activeDevice: { id: 'local_device', isLocal: true } } }), now });
  const source = createSourceCore({ port: pair.main, authority, now, timeoutMs: 400 });
  return { source, calls, ready: source.start(), rejectCompletion() { complete = false; },
    delayNext(promise) { delayNext = promise; }, inspect: pair.inspect,
    replaceProcess() { processCurrent = false; },
    close() { connected = false; source.close(); endpoint.close(); },
  };
}
module.exports = { createSharedRouteHarness };
