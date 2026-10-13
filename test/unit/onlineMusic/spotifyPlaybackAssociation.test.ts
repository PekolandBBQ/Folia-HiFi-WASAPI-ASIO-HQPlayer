import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
// test/unit/onlineMusic/spotifyPlaybackAssociation.test.ts — paused challenge recovery and revocation boundaries.
const { createPlaybackAssociation } = createRequire(import.meta.url)('../../../electron/spotify/playbackAssociation.cjs');
const uri = 'spotify:track:' + 'A'.repeat(22);
function fixture(extra: Record<string, any> = {}) {
  const state = { position: 5000, revision: 1, failScope: false,
    onSeek: (_target: number, _count: number) => {}, controls: [] as number[] };
  const owner = { pid: 101, startTicks: '10000', uid: 1000, executableDevice: 1, executableInode: 123, executableSha256: 'c'.repeat(64),
    wsPort: 9000, zeroConfPort: 9001, wsSocketPid: 101, zeroConfSocketPid: 101, wsSocketStartTicks: '10000', zeroConfSocketStartTicks: '10000' };
  const probe = createPlaybackAssociation({ now: () => 1000, choosePosition: () => 12000,
    scopeSnapshot() {
      if (state.failScope) throw Object.assign(new Error('grant-revoked'), { code: 'SESSION_CHANGED' });
      return { epoch: 1, revision: state.revision, scopes: ['user-read-playback-state'] };
    },
    readCatalogFresh: async () => ({ receivedAt: 1000, user: { id: 'test-account' }, devices: { devices: [{ id: 'test-device', is_active: true }] },
      playback: { device: { id: 'test-device', is_active: true }, is_playing: false, item: { type: 'track', uri, duration_ms: 180000 }, progress_ms: state.position } }),
    readOwnedSoloistFresh: async () => ({ receivedAt: 1000, owner: { ...owner }, authState: { logged_in: true, is_active: true },
      zeroConf: { deviceID: 'unproven-zc-id', status: 101, spotifyError: 0 }, playback: { status: 'paused', speed: 0, uri, durationMs: 180000, positionMs: state.position } }),
    seekOwnedPaused: async (request: { expectedPositionMs: number; positionMs: number }) => {
      expect(request.expectedPositionMs).toBe(state.position); state.controls.push(request.positionMs);
      state.position = request.positionMs; state.onSeek(request.positionMs, state.controls.length);
    }, ...extra });
  return { state, probe };
}
describe('Spotify paused association failure recovery uses actual module', () => {
  it('keeps the proven device binding main-only and only publishes it after confirmed restoration', async () => {
    const values: any[] = []; const f = fixture({ onVerified: (value: any) => values.push(value) });
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(values).toHaveLength(1); expect(values[0]).toMatchObject({ deviceId: 'test-device', accountId: 'test-account', uri,
      stamp: { epoch: 1, revision: 1 } });
    expect(JSON.stringify(result)).not.toContain('test-device'); expect(JSON.stringify(result)).not.toContain('test-account');
  });
  it('never acquires a private playback target after a failed or revoked challenge', async () => {
    const values: any[] = []; const f = fixture({ onVerified: (value: any) => values.push(value) });
    f.state.onSeek = (_target, count) => { if (count === 1) f.state.revision++; };
    expect((await f.probe.verify({ authorizePausedChallenge: true })).reason).toBe('SESSION_CHANGED'); expect(values).toEqual([]);
  });
  it('releases its busy flag when reading the initial grant snapshot throws', async () => {
    const f = fixture(); f.state.failScope = true;
    expect((await f.probe.verify()).reason).toBe('SESSION_CHANGED');
    f.state.failScope = false;
    expect((await f.probe.verify()).reason).toBe('CHALLENGE_NOT_AUTHORIZED');
    expect(f.state.controls).toEqual([]);
  });
  it('reads back a lost challenge ACK and restores the original paused position only once', async () => {
    const f = fixture(); f.state.onSeek = (_target, count) => { if (count === 1) throw new Error('synthetic-ack-timeout'); };
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.canonicalIdentityVerified).toBe(false);
    expect(result.restoration).toBe('confirmed-after-failed-probe');
    expect(f.state.controls).toEqual([12000, 5000]); expect(f.state.position).toBe(5000);
  });
  it('uses observed original position after a lost restore ACK without repeating control', async () => {
    const f = fixture(); f.state.onSeek = (_target, count) => { if (count === 2) throw new Error('synthetic-ack-timeout'); };
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.restoration).toBe('already-at-original');
    expect(f.state.controls).toEqual([12000, 5000]);
  });
  it('keeps an unconfirmed restoration unverified and never retries the restore', async () => {
    const f = fixture(); f.state.onSeek = (_target, count) => { if (count === 2) { f.state.position = 12000; throw new Error('synthetic-restore-timeout'); } };
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.restoration).toBe('unconfirmed');
    expect(f.state.controls).toEqual([12000, 5000]); expect(f.state.position).toBe(12000);
  });
  it('does not overwrite a user position change after the challenge', async () => {
    const f = fixture(); f.state.onSeek = (_target, count) => { if (count === 1) f.state.position = 50000; };
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(result.accountPlaybackAssociation).toBe('unverified'); expect(result.restoration).toBe('skipped-external-interaction');
    expect(f.state.controls).toEqual([12000]); expect(f.state.position).toBe(50000);
  });
  it('never restores into a revoked or replaced grant', async () => {
    const f = fixture(); f.state.onSeek = (_target, count) => { if (count === 1) f.state.revision++; };
    const result = await f.probe.verify({ authorizePausedChallenge: true });
    expect(result.reason).toBe('SESSION_CHANGED'); expect(result.restoration).toBe('skipped-revoked-session');
    expect(result.accountPlaybackAssociation).toBe('unverified'); expect(f.state.controls).toEqual([12000]);
  });
});
