'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { officialTrack, TRACK_ID } = require('../fixtures/spotifyOfficialTrack.cjs');

// Exact production catalog and source-preparation metadata paths with 450ms
// synthetic GETs. This is not first-PCM, Windows, network, route or DAC timing.
const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const { createSpotifyCatalog } = require(path.join(root, 'electron/spotify/catalog.cjs'));
const { createOfficialTrackMetadata } = require(path.join(root, 'electron/spotify/officialTrackMetadata.cjs'));
const { createCableAudioPreparation } = require(path.join(root, 'electron/spotify/cableAudioPreparation.cjs'));
const selection = { deviceId: 'synthetic-desktop', captureDeviceId: 'synthetic-capture', renderDeviceId: 'synthetic-render',
  outputDeviceId: 'synthetic-output', temporaryFormatLease: true };
function fixture() {
  let offset = 0, revision = 1, envelope = 'item';
  const calls = [], now = () => Date.now() + offset;
  const vault = { stamp: () => ({ epoch: 1, revision }), token: async () => 'synthetic-do-not-log',
    grantedScopes: async () => ({ scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) };
  const cooldown = { load: async () => 0, defer: async () => { throw new Error('unexpected'); } };
  const officialMetadata = createOfficialTrackMetadata({ getStamp: vault.stamp, now });
  const fetcher = async address => {
    const url = new URL(address); assert.equal(url.origin, 'https://api.spotify.com');
    calls.push(url.pathname); await delay(450);
    if (url.pathname.endsWith('/me/tracks')) return Response.json({ items: [{ [envelope]: officialTrack() }] });
    return Response.json(officialTrack(TRACK_ID));
  };
  const catalog = createSpotifyCatalog({ vault, cooldown, officialMetadata, fetcher, now });
  const mixFormat = { sampleRate: 44100, channels: 2 };
  const config = { ready: true, issues: [], selectedSampleRate: 44100, selectedChannels: 2,
    preparedFormat: 's32le', sampleRateConversion: false,
    capture: { id: selection.captureDeviceId, flow: 'capture', supportedBaseCable: true, mixFormat },
    render: { id: selection.renderDeviceId, flow: 'render', supportedBaseCable: true, mixFormat },
    sessions: [{ processId: 1234, startedAtUnixMs: 1700000000000, state: 'inactive', identityReadable: true,
      processName: 'Spotify', executablePath: 'C:\\Synthetic\\Spotify.exe' }],
    route: { ready: true, spotifyOnlyObserved: true, spotifySessionPresent: true } };
  const facts = { deviceId: selection.deviceId, trackId: TRACK_ID, durationMs: 180000, positionMs: 0, isPlaying: false };
  const audio = createCableAudioPreparation({ vault, cooldown, officialMetadata, fetcher, now,
    captureHost: { inspectRoute: async () => config, open: async () => { throw new Error('no capture in metadata benchmark'); } },
    control: { prepare: async () => facts, readState: async () => facts, play: async () => facts,
      pause: async () => facts, seek: async () => facts, close: async () => {} },
    getSelection: async () => selection,
    media: { add: async () => ({ url: 'http://127.0.0.1:1234/fixture', revoke: async () => {} }), close: async () => {} } });
  return { audio, catalog, officialMetadata, calls, envelope: value => { envelope = value; },
    expire: () => { offset += 60000; }, change: () => { revision++; } };
}
async function scenario(name, setup, execute) {
  const f = fixture(); await setup(f); const before = f.calls.length, started = performance.now();
  try { await execute(f); return { name, measuredMs: Math.round((performance.now() - started) * 1000) / 1000,
    measuredGetCount: f.calls.length - before, measuredRequests: f.calls.slice(before),
    seedGetCount: before, allRequests: f.calls.slice() }; }
  finally { await f.audio.close(); f.catalog.clear(); }
}
const prepare = f => f.audio.prepare(TRACK_ID, randomUUID());
const browse = f => f.catalog.request('savedTracks');
(async () => {
  const results = [];
  results.push(await scenario('cold-source-metadata', async () => {}, prepare));
  results.push(await scenario('official-item-browse-to-source', browse, prepare));
  results.push(await scenario('legacy-track-browse-to-source', async f => { f.envelope('track'); await browse(f); }, prepare));
  results.push(await scenario('expired-item-browse-to-source', async f => { await browse(f); f.expire(); }, prepare));
  results.push(await scenario('changed-account-item-browse-to-source', async f => { await browse(f); f.change(); }, prepare));
  results.push(await scenario('repeated-catalog-detail', f => f.catalog.request('song', { id: TRACK_ID }),
    f => f.catalog.request('song', { id: TRACK_ID })));
  console.log(JSON.stringify({ root, delayMs: 450, realSpotifyRequests: 0, windowsExecution: false,
    boundary: 'source prepare or repeated catalog detail, synthetic control/capture/selection/media; excludes first PCM', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
