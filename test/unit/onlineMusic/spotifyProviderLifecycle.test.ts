import { afterEach, expect, it, vi } from 'vitest';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';

// test/unit/onlineMusic/spotifyProviderLifecycle.test.ts: real provider/transport contract over isolated IPC.
afterEach(() => vi.unstubAllGlobals());
const fixture = () => {
    const request = vi.fn(async (_input: any): Promise<any> => ({ revision: 12, ownsRoute: true }));
    vi.stubGlobal('window', { electron: { spotify: { request } } });
    return request;
};
it('non-cable runtime source transitions remain no-ops without invoking unknown operations', async () => {
    const request = fixture(); request.mockResolvedValue({ ownsRoute: false });
    await spotifyProvider.playback!.leaveSource!(); expect(request).toHaveBeenCalledTimes(1);
});
it('main-process stale exit is cancellation and never becomes a track-unavailable error', async () => {
    const request = fixture(); request.mockResolvedValueOnce({ revision: 12, ownsRoute: true })
        .mockResolvedValueOnce({ spotifyError: { code: 'unavailable', message: 'Spotify: request-cancelled' } });
    await expect(spotifyProvider.playback!.leaveSource!()).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenLastCalledWith({ action: 'leaveProvider', expectedSourceRevision: 12 });
});
it('a cancelled revision snapshot cannot later send provider exit', async () => {
    const request = fixture(), abort = new AbortController();
    request.mockImplementationOnce(async () => { abort.abort(); return { revision: 12, ownsRoute: true }; });
    await expect(spotifyProvider.playback!.leaveSource!({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(1);
});
