// @vitest-environment jsdom
import { expect, it, vi, afterEach } from 'vitest';
import { createSpotifyActivation, spotifyActivation } from '@/services/onlineMusic/spotifyActivation';
import { requestSpotify } from '@/services/onlineMusic/spotifyTransport';

// test/unit/onlineMusic/spotifyActivation.test.ts — startup network waits for a fresh explicit intent.
afterEach(() => { delete window.electron; });
it('does not infer selection from an account, and only releases waiting work once', async () => {
    const gate = createSpotifyActivation(), listener = vi.fn(), done = vi.fn();
    gate.subscribe(listener);
    const pending = gate.wait().then(done);
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    gate.select(); gate.select(); await pending;
    expect(done).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledOnce();
    expect(createSpotifyActivation().selected()).toBe(false);
});
it('cancels a deferred request without selecting or sending it', async () => {
    const gate = createSpotifyActivation(), controller = new AbortController();
    const pending = gate.wait(controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(gate.selected()).toBe(false); gate.select();
});
it('does not send saved-account status or library work before a real search selects Spotify', async () => {
    const bridge = vi.fn(async ({action}) => ({action}));
    Object.defineProperty(window, 'electron', { configurable: true, value: {spotify:{request:bridge}} });
    expect(spotifyActivation.selected()).toBe(false);
    const status = requestSpotify({action:'status'});
    const library = requestSpotify({action:'recommendations'});
    await Promise.resolve(); expect(bridge).not.toHaveBeenCalled();
    await requestSpotify({action:'search',query:'millsage'});
    await Promise.all([status,library]);
    expect(bridge.mock.calls.map(([input])=>input.action).sort()).toEqual(['recommendations','search','status']);
});
