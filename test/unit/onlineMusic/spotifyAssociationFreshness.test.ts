import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/spotifyAssociationFreshness.test.ts: completed observation freshness across slow owner construction.
const { createPlaybackAssociation } = createRequire(import.meta.url)('../../../electron/spotify/playbackAssociation.cjs');
function fixture({ staleCatalog = false, futureGuest = false } = {}) {
  let clock = 1000, position = 8000;
  const uri = 'spotify:track:' + 'A'.repeat(22);
  return createPlaybackAssociation({ now: () => clock,
    scopeSnapshot: () => ({ epoch: 1, revision: 1, scopes: ['user-read-playback-state'] }),
    readOwnedSoloistFresh: async () => { clock += 12000; return { receivedAt: clock + (futureGuest ? 100000 : 0),
      owner: { pid: 42, startTicks: '50', wsPort: 9000, zeroConfPort: 9001, wsSocketPid: 42, zeroConfSocketPid: 42,
        wsSocketStartTicks: '50', zeroConfSocketStartTicks: '50' },
      authState: { logged_in: true, is_active: true }, playback: { status: 'paused', speed: 0, uri, durationMs: 120000, positionMs: position },
      zeroConf: { deviceID: 'unproven', status: 101, spotifyError: 0 } }; },
    readCatalogFresh: async () => { clock += 20; return { receivedAt: staleCatalog ? clock - 12020 : clock, user: { id: 'account' },
      devices: { devices: [{ id: 'device', is_active: true }] }, playback: { device: { id: 'device', is_active: true }, is_playing: false,
        item: { type: 'track', uri, duration_ms: 120000 }, progress_ms: position } }; },
    seekOwnedPaused: async (request: any) => { position = request.positionMs; }, choosePosition: () => 45000 });
}
it('slow process proof uses newly returned observations and still restores the exact paused checkpoint', async () => {
  const result = await fixture().verify({ authorizePausedChallenge: true });
  expect(result.accountPlaybackAssociation).toBe('verified-by-fresh-challenge'); expect(result.restoration).toBe('confirmed');
  expect(result.evidence.restoredPositionMs).toBe(8000);
});
it('a catalog response predating the current slow proof stays rejected', async () => {
  expect((await fixture({ staleCatalog: true }).verify({ authorizePausedChallenge: true })).reason).toBe('STALE_OBSERVATION');
});
it('an impossible future guest timestamp stays rejected', async () => {
  expect((await fixture({ futureGuest: true }).verify()).reason).toBe('STALE_OBSERVATION');
});
