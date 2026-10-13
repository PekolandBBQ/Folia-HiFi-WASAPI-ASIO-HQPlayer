'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');

// test/isolated/spotify/emptyPlayerMute.test.cjs: real production modules with synthetic HTTP only.
const runtime = process.env.FOLIA_CANDIDATE_ROOT || path.resolve(__dirname, '../../..');
const original = process.env.FOLIA_R22_BASELINE_ROOT;
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp';
const session = '12345678-1234-1234-1234-123456789abc';
function fixture(root = runtime, options = {}) {
  const { createDesktopPlaybackControl } = require(path.join(root, 'electron/spotify/desktopPlaybackControl.cjs'));
  const { installPreviewDiagnosticSink } = require(path.join(root, 'electron/debug/privatePreviewDiagnosticBus.cjs'));
  let state = null, revision = 0, muted = false, selected = false, stateReads = 0, deviceReads = 0;
  const device = { id: 'desktop-1', type: 'Computer', is_active: !!options.active,
    is_restricted: false, supports_volume: true, volume_percent: 42 };
  if (options.initialState) state = options.initialState(device);
  const log = [], events = [];
  const detach = installPreviewDiagnosticSink({ enabled: () => true, record: (type, fields) => events.push({ type, fields }) });
  const stateBody = () => ({ device: { ...device, is_active: true }, item: { type: 'track',
    uri: `spotify:track:${trackId}`, duration_ms: 120000 }, currently_playing_type: 'track',
    progress_ms: 50, is_playing: true, actions: { disallows: {} } });
  const fetcher = async (address, init) => {
    const url = new URL(address), operation = url.pathname.split('/').at(-1);
    const volume = Number(url.searchParams.get('volume_percent'));
    log.push(`${init.method}:${operation}${operation === 'volume' ? `:${volume}` : ''}`);
    if (init.method === 'GET') {
      if (operation === 'devices') {
        let devices = [{ ...device }];
        if (muted && !selected) {
          await options.onReadback?.();
          const sample = deviceReads++;
          await delay(options.deviceDelays?.[sample] ?? options.deviceDelay ?? 0);
          if (options.volumeSamples) devices[0].volume_percent = options.volumeSamples[sample % options.volumeSamples.length];
          if (options.afterMuteDevices) devices = options.afterMuteDevices(devices, sample);
          if (options.deviceResponse) return options.deviceResponse(devices, sample);
        } else if (!muted && options.beforeMuteDevices) devices = options.beforeMuteDevices(devices);
        return Response.json({ devices });
      }
      if (muted && !selected) {
        const sample = stateReads++;
        await delay(options.stateDelays?.[sample] ?? options.stateDelay ?? 0);
        if (options.stateAfterMute) return Response.json(options.stateAfterMute(stateBody(), sample));
      }
      return state ? Response.json(state) : new Response(null, { status: 204 });
    }
    await options.onPut?.({ operation, volume });
    if (operation === 'volume') {
      if (volume === 0) {
        muted = true;
        if (options.onMute) options.onMute(() => { revision++; });
        await delay(options.putDelay ?? 0);
      }
      device.volume_percent = volume;
    }
    if (operation === 'player') { device.is_active = true; if (state) state.device = { ...device }; }
    if (operation === 'play') { selected = true; device.is_active = true; state = stateBody(); await delay(options.selectDelay ?? 0); }
    if (operation === 'pause') state.is_playing = false;
    if (operation === 'seek') state.progress_ms = Number(url.searchParams.get('position_ms'));
    return options.opaqueAck && operation === 'volume' ? new Response('OK', { status: 200 }) : new Response(null, { status: 204 });
  };
  const vault = { token: async () => 'synthetic-token', stamp: () => ({ epoch: 0, revision }),
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const control = createDesktopPlaybackControl({ vault, fetcher, cooldown: { load: async () => 0, defer: async () => 100000 },
    coldBootstrapDirectory: options.directory, settleTimeoutMs: options.budget ?? 400, settleIntervalMs: options.interval ?? 40 });
  return { device, log, events, control, state: () => state,
    prepare: (extra = {}) => control.prepare({ session, deviceId: device.id, trackId, durationMs: 120000,
      restoreSavedTarget: true, beforeSelect: async () => log.push('route:acquire'), coldBootstrap: async () => log.push('identity'), ...extra }),
    async close() { await control.dispose(); detach(); },
    writes: () => log.filter(entry => entry.startsWith('PUT:')) };
}
async function using(root, options, action) {
  const f = fixture(root, options), keepAlive = setInterval(() => {}, 1000);
  try { await action(f); } finally { clearInterval(keepAlive); await f.close(); }
}

for (const active of [false, true]) test(`empty player target active=${active} still requires mute, select, pause, restore`, async () => {
  await using(runtime, { active }, async f => {
    const result = await f.prepare(); assert.equal(result.isPlaying, false);
    assert.equal(f.device.volume_percent, 42);
    const mute = f.events.filter(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute');
    assert.deepEqual(mute.filter(event => event.fields.phase === 'observed').map(event =>
      [event.fields.observedEmpty, event.fields.volumeMatched]), [[true, true], [true, true]]);
    assert(mute.every(event => !Object.hasOwn(event.fields, 'paused')));
    assert(f.log.indexOf('route:acquire') > f.log.indexOf('PUT:volume:42'));
  });
});

test('synthetic delayed readback demonstrates serial budget pressure without weakening two-zero proof', async () => {
  const profile = { putDelay: 120, stateDelays: [40, 55, 28], deviceDelays: [28, 30, 28], volumeSamples: [42, 0, 0] };
  if (original) await using(original, profile, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
  });
  await using(runtime, profile, async f => {
    await f.prepare();
    const observations = f.events.filter(event => event.type === 'spotify.cold-bootstrap'
      && event.fields.stage === 'mute' && event.fields.phase === 'observed');
    assert.deepEqual(observations.map(event => event.fields.volumeMatched), [false, true, true]);
    assert.deepEqual(observations.map(event => event.fields.observationCount), [1, 2, 3]);
    assert.equal(f.device.volume_percent, 42);
  });
});

test('204 acknowledgment and alternating volume values never authorize transfer or select', async () => {
  await using(runtime, { volumeSamples: [42, 0] }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert.equal((await f.control.inspectColdRecovery()).required, true);
    assert(!f.events.some(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'completed'));
  });
});

for (const is_active of [true, undefined, 'false']) test(`foreign activity ${String(is_active)} blocks before mutation`, async () => {
  await using(runtime, { beforeMuteDevices: devices => [...devices, { id: 'phone-1', type: 'Smartphone', is_active }] }, async f => {
    await assert.rejects(f.prepare(), { code: 'PLAYBACK_STATE_UNCONFIRMED' });
    assert.deepEqual(f.writes(), []);
  });
});

test('a foreign active device appearing after mute is a sticky conflict', async () => {
  await using(runtime, { afterMuteDevices: devices => [...devices, { id: 'phone-1', type: 'Smartphone', is_active: true }] }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert.equal((await f.control.inspectColdRecovery()).required, true);
  });
});

test('a changed nonempty state cannot be hidden by a concurrent zero volume result', async () => {
  await using(runtime, { stateAfterMute: state => state }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
  });
});

test('deadline during mute request is normalized and keeps the unresolved receipt', async () => {
  await using(runtime, { putDelay: 600, budget: 120, interval: 40 }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    const failure = f.events.find(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'failed');
    assert.equal(failure.fields.errorCode, 'CONTROL_TIMEOUT');
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert.equal((await f.control.inspectColdRecovery()).required, true);
    await delay(650); assert.deepEqual(f.writes(), ['PUT:volume:0']);
  });
});

test('a grant change preserves cancellation authority and cannot clear or select', async () => {
  await using(runtime, { onMute: changeGrant => changeGrant() }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert.equal((await f.control.inspectColdRecovery()).required, true);
  });
});

test('unchanged original-volume readbacks remain unconfirmed until the bounded deadline', async () => {
  await using(runtime, { volumeSamples: [42], budget: 120 }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    const mute = f.events.filter(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute');
    assert(mute.some(event => event.fields.phase === 'observed'));
    assert(mute.filter(event => event.fields.phase === 'observed').every(event => event.fields.volumeMatched === false));
    const failure = mute.find(event => event.fields.phase === 'failed');
    assert(failure.fields.observationCount > 0);
    assert.notEqual(failure.fields.errorCode, 'UNKNOWN');
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
  });
});

for (const side of ['state', 'device']) test(`one ${side} GET timeout and late success cannot form a sample or advance selection`, async () => {
  await using(runtime, { [`${side}Delay`]: 250, budget: 120 }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    const failure = f.events.find(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'failed');
    assert.equal(failure.fields.errorCode, 'CONTROL_TIMEOUT');
    assert.equal(failure.fields.observationCount, 0);
    await delay(280);
    assert(!f.events.some(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'observed'));
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert.equal((await f.control.inspectColdRecovery()).required, true);
  });
});

test('caller abort while the pair is pending cannot be replaced by late successful GETs', async () => {
  const controller = new AbortController();
  await using(runtime, { stateDelay: 200, deviceDelay: 200,
    onMute: () => setTimeout(() => controller.abort(), 25) }, async f => {
    await assert.rejects(f.prepare({ signal: controller.signal }));
    await delay(230);
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
    assert(!f.events.some(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'observed'));
    assert.equal((await f.control.inspectColdRecovery()).required, true);
  });
});

for (const conflict of ['missing', 'duplicate', 'unsupported', 'unknown-volume', 'third-volume'])
  test(`concurrent exact-device ${conflict} readback blocks all later commands`, async () => {
    const change = devices => {
      if (conflict === 'missing') return [];
      if (conflict === 'duplicate') return [...devices, { ...devices[0] }];
      if (conflict === 'unsupported') devices[0].supports_volume = false;
      if (conflict === 'unknown-volume') devices[0].volume_percent = null;
      if (conflict === 'third-volume') devices[0].volume_percent = 11;
      return devices;
    };
    await using(runtime, { afterMuteDevices: change }, async f => {
      await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
      assert.deepEqual(f.writes(), ['PUT:volume:0']);
      assert.equal((await f.control.inspectColdRecovery()).required, true);
    });
  });

test('opaque HTTP200 still requires both fresh zero samples', async () => {
  await using(runtime, { opaqueAck: true }, async f => {
    await f.prepare();
    const mute = f.events.filter(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'observed');
    assert.deepEqual(mute.map(event => event.fields.volumeMatched), [true, true]);
    assert.equal(f.device.volume_percent, 42);
  });
});

test('nonempty frozen remote baseline keeps its existing targeted mute and transfer path', async () => {
  const otherTrackId = '4n4Qqam7vgaVa1iaRUc9Lp';
  await using(runtime, { initialState: device => ({ device: { ...device, id: 'phone-1', is_active: true },
    item: { type: 'track', uri: `spotify:track:${otherTrackId}`, duration_ms: 120000 },
    is_playing: true, progress_ms: 27000 }),
    beforeMuteDevices: devices => [...devices, { id: 'phone-1', type: 'Smartphone', is_active: true }] }, async f => {
    await f.prepare();
    assert.deepEqual(f.writes().slice(0, 3), ['PUT:volume:0', 'PUT:player', 'PUT:play']);
    assert.equal(f.device.volume_percent, 42);
  });
});

test('disk receipt is written ahead of volume and playback boundaries and cleared only after restoration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-r23-mute-'));
  const filename = path.join(directory, 'cold-volume-recovery.json');
  const snapshots = [];
  try {
    await using(runtime, { directory, budget: 1000,
      onPut: async ({ operation, volume }) => {
        // Normal route playback occurs after the cold receipt has already cleared.
        let receipt;
        try { receipt = JSON.parse(await readFile(filename, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' && operation !== 'volume') return; throw error; }
        snapshots.push([operation, volume, receipt]);
        assert.equal(receipt.version, 2); assert.equal(receipt.originalVolume, 42);
        assert.equal(receipt.baselineEmpty, true); assert.equal(receipt.targetActive, false);
        if (operation === 'volume') {
          assert.equal(receipt.volumeRequestPending, true); assert.equal(receipt.playbackRequestPending, false);
        }
        if (['player', 'play', 'pause', 'seek'].includes(operation)) {
          assert.equal(receipt.volumeOnly, false); assert.equal(receipt.playbackRequestPending, true);
        }
      },
      onReadback: async () => assert.equal(JSON.parse(await readFile(filename, 'utf8')).volumeRequestPending, false),
    }, async f => {
      await f.prepare();
      await assert.rejects(readFile(filename), { code: 'ENOENT' });
      assert.equal((await f.control.inspectColdRecovery()).required, false);
    });
    assert(snapshots.some(([operation, volume, receipt]) => operation === 'volume' && volume === 0 && receipt.volumeOnly));
    assert(snapshots.some(([operation, volume, receipt]) => operation === 'volume' && volume === 42 && !receipt.volumeOnly));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pending volume receipt remains true after a late transport response', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-r23-late-volume-'));
  const filename = path.join(directory, 'cold-volume-recovery.json');
  try {
    await using(runtime, { directory, putDelay: 250, budget: 120 }, async f => {
      await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
      await delay(280);
      const receipt = JSON.parse(await readFile(filename, 'utf8'));
      assert.equal(receipt.volumeRequestPending, true); assert.equal(receipt.volumeOnly, true);
      assert.deepEqual(f.writes(), ['PUT:volume:0']);
      await assert.rejects(f.control.checkColdRecovery({ deviceId: 'desktop-1' }), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('successful cleanup pause cannot erase an older unconfirmed select', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-r23-late-select-'));
  const filename = path.join(directory, 'cold-volume-recovery.json');
  try {
    await using(runtime, { directory, selectDelay: 250, budget: 120 }, async f => {
      await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
      assert.equal(f.state().is_playing, false);
      assert(f.writes().includes('PUT:pause')); assert(!f.writes().includes('PUT:volume:42'));
      await delay(280);
      const receipt = JSON.parse(await readFile(filename, 'utf8'));
      assert.equal(receipt.playbackRequestPending, true); assert.equal(receipt.volumeOnly, false);
      assert.equal(receipt.volumeRequestPending, false);
      await assert.rejects(f.control.checkColdRecovery({ deviceId: 'desktop-1' }), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP200 device headers without a completed body never count as a volume sample', async () => {
  await using(runtime, { budget: 120, deviceResponse: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"devices":')); },
  }), { status: 200, headers: { 'content-type': 'application/json' } }) }, async f => {
    await assert.rejects(f.prepare(), { code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' });
    const failure = f.events.find(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'failed');
    assert.equal(failure.fields.errorCode, 'CONTROL_TIMEOUT'); assert.equal(failure.fields.observationCount, 0);
    assert(f.events.some(event => event.type === 'spotify.http' && event.fields.endpoint === 'playback-devices' && event.fields.httpStatus === 200));
    assert(!f.events.some(event => event.type === 'spotify.cold-bootstrap' && event.fields.stage === 'mute' && event.fields.phase === 'observed'));
    assert.deepEqual(f.writes(), ['PUT:volume:0']);
  });
});
