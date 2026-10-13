'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const application = process.env.FOLIA_CONTROL_TEST_APP || path.resolve(__dirname, '../../..');
const { createDesktopPlaybackControl } = require(path.join(application, 'electron/spotify/desktopPlaybackControl.cjs'));
const { installPreviewDiagnosticSink } = require(path.join(application, 'electron/debug/privatePreviewDiagnosticBus.cjs'));

// Production source controller and API, with local fault schedules only; no account, audio, COM or network access.
const TRACK = '3n3Ppam7vgaVa1iaRUc9Lp', OTHER = '4n4Qqam7vgaVa1iaRUc9Lp', SESSION = randomUUID();
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-r38-selection-'));
  const receipt = path.join(directory, 'source-preparation-recovery.json');
  let clock = 10000, revision = 0, selected = false, reads = 0, cleanupParked = false;
  const calls = [], diagnostics = [], abort = new AbortController();
  const uninstall = options.diagnostics ? installPreviewDiagnosticSink({ enabled: () => true,
    record: (type, fields) => { diagnostics.push({ type, fields }); return true; } }) : () => {};
  const device = { id: 'synthetic-desktop', is_active: true, is_restricted: false, type: 'computer' };
  const state = { device, item: { uri: `spotify:track:${OTHER}`, type: 'track', duration_ms: 120000 },
    currently_playing_type: 'track', is_playing: false, progress_ms: 0, actions: { disallows: {} } };
  const vault = { stamp: () => ({ epoch: 0, revision }), token: async () => 'synthetic-not-a-credential',
    grantedScopes: async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const control = createDesktopPlaybackControl({ vault, coldBootstrapDirectory: directory,
    cooldown: { load: async () => 0, defer: async () => 0 }, now: () => clock,
    wait: async ms => { clock += ms; }, settleTimeoutMs: 4000, settleIntervalMs: 400,
    readRoutePcmEvidence: (session, generation) => session === SESSION && generation === 1,
    fetcher: async (address, init) => {
      const url = new URL(address), operation = init.method === 'GET'
        ? url.pathname.endsWith('/devices') ? 'devices' : 'state'
        : url.pathname.endsWith('/pause') ? 'pause' : url.pathname.endsWith('/play') ? 'select' : 'unexpected';
      calls.push(operation);
      if (operation === 'devices') return Response.json({ devices: [device] });
      if (operation === 'state') {
        if (selected && ++reads === 1 && !options.selectError) {
          clock += 1000;
          return Response.json({ ...state, item: { ...state.item, uri: `spotify:track:${OTHER}` } });
        }
        if (selected && reads === 2 && !options.selectError) {
          // The dispatched select has answered. Only its state confirmation expires.
          clock += 4000;
          if (options.cancel) abort.abort();
          if (options.accountChange) revision++;
          if (options.unfinishedObservation) throw Object.assign(new Error('synthetic GET deadline'), { code: 'CONTROL_TIMEOUT' });
        }
        if (selected && reads >= (options.selectError ? 1 : 3)) {
          if (options.changedTrack) state.item.uri = `spotify:track:${OTHER}`;
          if (options.wrongDevice) state.device = { ...device, id: 'foreign-desktop' };
          if (options.alreadyPaused) state.is_playing = false;
        }
        clock += 10; return Response.json(state);
      }
      assert.equal(url.searchParams.get('device_id'), device.id);
      if (operation === 'select') {
        selected = true; state.item.uri = `spotify:track:${TRACK}`; state.is_playing = true;
        if (options.selectError === 'error-body') return Response.json({ error: 'synthetic' });
        if (options.selectError === 'http-error') return new Response(null, { status: 500 });
        if (options.selectError === 'transport-error') throw new Error('synthetic transport failure');
        return new Response(options.select200 ? 'opaque acknowledgment' : null, { status: options.select200 ? 200 : 204 });
      }
      assert.equal(operation, 'pause'); state.is_playing = false;
      if (options.staleCleanupProof) clock += 6000;
      if (options.changedGeneration) await control.routeSourceControl({ session: SESSION, generation: 2, action: 'read',
        sourceDeviceId: device.id, expectedSourceUri: `spotify:track:${TRACK}` });
      if (options.replaceReceipt) await writeFile(receipt, '{"changed":true}\n');
      if (options.pauseError) return Response.json({ error: 'synthetic pause error' });
      return new Response('opaque pause acknowledgment', { status: 200 });
    } });
  const prepare = () => control.prepare({ session: SESSION, deviceId: device.id, trackId: TRACK,
    durationMs: 120000, restoreSavedTarget: true, signal: abort.signal,
    onRouteParked: () => { cleanupParked = true; }, routedPreparation: {
      beforeSelect: async () => control.routeSourceControl({ session: SESSION, generation: 1, action: 'read',
        sourceDeviceId: device.id, expectedSourceUri: `spotify:track:${OTHER}`, requirePreparationObservation: true,
        preparationPhase: 'baseline' }),
      afterSelect: async () => { throw new Error('Selection confirmation must fail first'); },
      afterPark: async () => { throw new Error('Failed preparation must never publish'); },
    } });
  return { control, prepare, calls, state, receipt, diagnostics, parked: () => cleanupParked,
    restore: () => control.routeSourceControl({ session: SESSION, generation: 1, action: 'read',
      sourceDeviceId: device.id, expectedSourceUri: `spotify:track:${TRACK}`, restoreOperationId: randomUUID(),
      allowChangedTrackPausedForRestore: true, allowEmptyPlayerForRestore: true }),
    close: async () => { await control.dispose(); uninstall(); await rm(directory, { recursive: true, force: true }); } };
}

test('settled 204 select observation timeout may retire only its exact intent after same-owner cleanup Pause', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.prepare(), { code: 'PLAYBACK_STATE_UNCONFIRMED' });
    assert.equal(f.parked(), true); assert.equal(f.state.is_playing, false);
    assert.deepEqual(f.calls.filter(x => ['select', 'pause'].includes(x)), ['select', 'pause']);
    await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
    const before = f.calls.length, proof = await f.restore();
    assert.equal(f.calls.length, before + 1, 'native restoration still obtains a new source GET');
    assert.equal(proof.isPlaying, false); assert.equal(proof.playbackRequestPending, false); assert.equal(proof.pcmStopped, true);
  } finally { await f.close(); }
});

test('select 204 failure reports only completed observation facts and never raw identities or unfinished GETs', async () => {
  const f = await fixture({ diagnostics: true, unfinishedObservation: true });
  try {
    await assert.rejects(f.prepare(), { code: 'PLAYBACK_STATE_UNCONFIRMED' });
    const row = f.diagnostics.find(row => row.type === 'spotify.playback-control'
      && row.fields.endpoint === 'playback-select' && row.fields.phase === 'failed');
    assert.deepEqual(row.fields, { endpoint: 'playback-select', method: 'PUT', httpStatus: 204, phase: 'failed',
      observationCount: 1, deviceMatched: true, trackMatched: false, playing: true,
      positionWithinTolerance: true, errorCode: 'PLAYBACK_STATE_UNCONFIRMED' });
    assert.doesNotMatch(JSON.stringify(row), /synthetic-desktop|3n3Ppam7vgaVa1iaRUc9Lp|4n4Qqam7vgaVa1iaRUc9Lp|spotify:track|credential|body|url/);
    assert.equal(f.calls.filter(value => value === 'state').length, 5, 'diagnostic adds no source reads');
    await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
  } finally { await f.close(); }
});

for (const [name, options] of Object.entries({
  'opaque select 200': { select200: true },
  'select error body': { selectError: 'error-body' },
  'select HTTP error': { selectError: 'http-error' },
  'unresolved select transport': { selectError: 'transport-error' },
  'pause error body': { pauseError: true },
  'changed selected track': { changedTrack: true },
  'wrong device': { wrongDevice: true },
  'changed account': { accountChange: true },
  'cancelled owner': { cancel: true },
  'replaced intent receipt': { replaceReceipt: true },
  'already paused without second cleanup observation': { alreadyPaused: true },
  'stale cleanup baseline': { staleCleanupProof: true },
  'changed native generation': { changedGeneration: true },
})) test(`${name} retains source recovery and blocks restoration before HTTP`, async () => {
  const f = await fixture(options);
  try {
    await assert.rejects(f.prepare());
    assert.ok(await readFile(f.receipt));
    const before = f.calls.length;
    await assert.rejects(f.restore()); assert.equal(f.calls.length, before);
    assert.equal(f.calls.filter(x => x === 'select').length, 1);
    if (options.changedTrack || options.wrongDevice || options.accountChange || options.cancel)
      assert.equal(f.calls.includes('pause'), false, 'a mismatched or cancelled source has no cleanup Pause authority');
  } finally { await f.close(); }
});
