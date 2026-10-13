// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fresh module models app restart. Only the unfinished flag is persisted;
// verified account/key/receiver state is always obtained from Omni on resume.
beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());
describe('Spotify connection restart marker', () => {
    it('reopens unfinished setup after restart but respects dismissal in the current run', async () => {
        const first = await import('@/stores/useSpotifyConnectionStore');
        first.useSpotifyConnectionStore.getState().begin();
        first.useSpotifyConnectionStore.getState().dismiss();
        expect(first.useSpotifyConnectionStore.getState()).toMatchObject({ open: false, pending: true });
        expect(localStorage.getItem(first.SPOTIFY_CONNECTION_PENDING_KEY)).toBe('true');
        vi.resetModules();
        const restarted = await import('@/stores/useSpotifyConnectionStore');
        expect(restarted.useSpotifyConnectionStore.getState()).toMatchObject({ open: true, pending: true });
        restarted.useSpotifyConnectionStore.getState().complete();
        vi.resetModules();
        const finished = await import('@/stores/useSpotifyConnectionStore');
        expect(finished.useSpotifyConnectionStore.getState()).toMatchObject({ open: false, pending: false });
        expect(localStorage.length).toBe(0);
    });
    it('keeps the guide usable when browser preferences cannot be persisted', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('unavailable'); });
        const { useSpotifyConnectionStore: store } = await import('@/stores/useSpotifyConnectionStore');
        expect(() => store.getState().begin()).not.toThrow();
        expect(store.getState().open).toBe(true);
        expect(() => store.getState().complete()).not.toThrow();
        expect(store.getState().open).toBe(false);
    });
});
