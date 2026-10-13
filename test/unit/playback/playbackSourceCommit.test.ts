import { afterEach, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { preparePlaybackSourceCommit } from '@/services/playbackSourceCommit';
import { registerPlaybackProviderOutput } from '@/services/playbackProviderOutput';

// test/unit/playback/playbackSourceCommit.test.ts: only a current successful source commit may leave Spotify.
const leave = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { leavePlaybackProvider: leave } }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.clearAllMocks(); });
const song = (provider: string) => ({ sourceRef: provider === 'local' ? { kind: 'local', mediaId: 'one' }
    : { kind: 'online', providerId: provider, mediaId: 'one' } }) as SongResult;
it.each(['local', 'kugou', 'qq', 'netease', 'navidrome'])('waits for old output then route exit before allowing %s source publication', async provider => {
    const order: string[] = [];
    cleanups.push(registerPlaybackProviderOutput('spotify', async () => { order.push('output'); }));
    leave.mockImplementationOnce(async () => { order.push('restore'); });
    await preparePlaybackSourceCommit(song(provider)); order.push('publish');
    expect(order).toEqual(['output', 'restore', 'publish']);
});
it('Spotify next/previous/repeat/backend commits do not restore the held provider route', async () => {
    const release = vi.fn(async () => {}); cleanups.push(registerPlaybackProviderOutput('spotify', release));
    await preparePlaybackSourceCommit(song('spotify'));
    expect(release).not.toHaveBeenCalled(); expect(leave).not.toHaveBeenCalled();
});
it('cancellation before or during output quiescence never sends a route exit', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(preparePlaybackSourceCommit(song('qq'), { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const pending = new AbortController();
    cleanups.push(registerPlaybackProviderOutput('spotify', async () => { pending.abort(); }));
    await expect(preparePlaybackSourceCommit(song('local'), { signal: pending.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(leave).not.toHaveBeenCalled();
});
it('restore failure blocks publication without replacing the error with an unavailable track verdict', async () => {
    const error = new Error('Spotify: automatic-route-restore-unconfirmed'); leave.mockRejectedValueOnce(error);
    await expect(preparePlaybackSourceCommit(song('netease'))).rejects.toBe(error);
});
