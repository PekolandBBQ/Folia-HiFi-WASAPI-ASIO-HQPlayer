'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopPlaybackApi } = require('../../../electron/spotify/desktopPlaybackApi.cjs');
const { playbackFacts } = require('../../../electron/spotify/desktopPlaybackFacts.cjs');

// Research counterexample only: production transport plus a hypothetical caller that combines two writes before reading. This caller is not shipped.
const TRACK = '3n3Ppam7vgaVa1iaRUc9Lp', OTHER = '4n4Qqam7vgaVa1iaRUc9Lp';

for (const mode of ['correct-select', 'incorrect-204', 'external-track-change']) {
  test(`compound select-204 then pause: ${mode} distinguishes final state proof from permission for the earlier pause`, async () => {
    const stamp = { epoch: 0, revision: 0 }, pausedUris = [];
    const record = { deviceId: 'synthetic-desktop', trackId: TRACK, durationMs: 120000,
      stamp, controller: new AbortController() };
    const state = { device: { id: record.deviceId, is_active: true, is_restricted: false },
      item: { uri: `spotify:track:${OTHER}`, type: 'track', duration_ms: 120000 },
      currently_playing_type: 'track', is_playing: false, progress_ms: 0 };
    const api = createDesktopPlaybackApi({ vault: { stamp: () => stamp, token: async () => 'synthetic-not-a-credential',
      grantedScopes: async () => ({ ...stamp, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) },
    cooldown: { load: async () => 0, defer: async () => 0 }, fetcher: async (address, init) => {
      const url = new URL(address);
      if (init.method === 'GET') return Response.json(state);
      assert.equal(url.searchParams.get('device_id'), record.deviceId);
      if (url.pathname.endsWith('/play')) {
        state.item.uri = `spotify:track:${mode === 'incorrect-204' ? OTHER : TRACK}`;
        state.is_playing = true;
      } else {
        assert.ok(url.pathname.endsWith('/pause'));
        pausedUris.push(state.item.uri); state.is_playing = false;
      }
      return new Response(null, { status: 204 });
    } });
    const check = () => record.controller.signal.throwIfAborted();
    const acknowledgment = await api.request('select', record, check, { positionMs: 0 });
    assert.equal(acknowledgment, null, 'this experiment is restricted to explicit HTTP 204');
    if (mode === 'external-track-change') state.item.uri = `spotify:track:${OTHER}`;
    await api.request('pause', record, check);
    const body = await api.request('state', record, check);
    if (mode === 'correct-select') {
      assert.equal(playbackFacts(body, record).isPlaying, false);
      assert.deepEqual(pausedUris, [`spotify:track:${TRACK}`]);
    } else {
      assert.throws(() => playbackFacts(body, record), { code: 'TRACK_NOT_CURRENT' });
      assert.deepEqual(pausedUris, [`spotify:track:${OTHER}`], 'the final refusal cannot undo the already-issued pause of a different source');
      assert.equal(state.is_playing, false);
    }
  });
}
