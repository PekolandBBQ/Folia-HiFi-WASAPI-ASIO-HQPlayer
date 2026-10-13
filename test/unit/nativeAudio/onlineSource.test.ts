import { afterEach, expect, it, vi } from 'vitest';
import { loadNativeOnlineSource } from '../../../src/services/nativeAudio/loadOnlineSource';
import type { NativeAudioApi } from '../../../src/types/nativeAudio';
import type { SongResult } from '../../../src/types';
import { usePlaybackStore } from '../../../src/stores/usePlaybackStore';
import { rememberAudioSourceQuality } from '../../../src/services/onlineMusic/audioSourceQuality';

// test/unit/nativeAudio/onlineSource.test.ts — preserve the resolved quality URL and cache bytes.
afterEach(() => { vi.unstubAllGlobals(); usePlaybackStore.setState({ currentSong: null, audioSrc: null }); });
function fixture() {
    const request = vi.fn(async (_request: Parameters<NativeAudioApi['request']>[0]) => ({}));
    return { supported: true, request, onEvent: vi.fn() } as NativeAudioApi & { request: typeof request };
}
it('passes the exact quality-selected URL to the host, without resolving it again', async () => {
    const api = fixture();
    const url = 'https://example.com/track?quality=hires&signature=unchanged';
    await loadNativeOnlineSource(api, 'online', url, 'asio', 'device', new AbortController().signal, 'integer-direct');
    expect(api.request.mock.calls.map(([request]) => request)).toEqual([
        { action: 'begin', livePcmPrebufferMs: 350, silent: true, session: 'online', url, compatibilityMode: false, backend: 'asio', deviceId: 'device', processingMode: 'integer-direct' },
        { action: 'finish', session: 'online' },
    ]);
});
it('uploads the existing cached blob bytes instead of downloading a new quality', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))));
    const api = fixture();
    await loadNativeOnlineSource(api, 'cached', 'blob:cached-song', 'wasapi-exclusive', 'device', new AbortController().signal, 'compatibility');
    expect(api.request.mock.calls.map(([request]) => request.action)).toEqual(['begin', 'chunk', 'finish']);
    expect(api.request.mock.calls[1][0].data).toEqual(new Uint8Array([7, 8, 9]));
});
it('does not finish or load a superseded request', async () => {
    const api = fixture();
    const controller = new AbortController();
    api.request.mockImplementationOnce(async () => { controller.abort(); return {}; });
    await expect(loadNativeOnlineSource(api, 'old', 'https://example.com/song', 'asio', 'device', controller.signal, 'compatibility')).rejects.toThrow();
    expect(api.request).toHaveBeenCalledOnce();
});
it('sends the current matching song duration as a hint before streaming metadata arrives', async () => {
    const api = fixture(), src = 'https://example.com/current';
    usePlaybackStore.setState({ audioSrc: src, currentSong: { id: 1, durationMs: 123456 } as SongResult });
    await loadNativeOnlineSource(api, 'song', src, 'asio', 'device', new AbortController().signal, 'integer-direct', -2, 'online:netease:1');
    expect(api.request.mock.calls[0][0]).toMatchObject({ action: 'begin', duration: 123.456 });
});
it.each(['https://example.com/metadata', 'blob:metadata'])('hands original source facts across begin for %s', async src => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))));
    const api = fixture(), song = { id: 42, durationMs: 123456 } as SongResult;
    const sourceMetadata = { quality: 'lossless' as const, requestedQuality: 'hires' as const,
        sourceFormat: { codec: 'flac', sampleRate: 44100, bitsPerSample: 16 } };
    rememberAudioSourceQuality(song, { url: src, fetchedAt: 0, ...sourceMetadata });
    usePlaybackStore.setState({ audioSrc: src, currentSong: song });
    await loadNativeOnlineSource(api, 'metadata', src, 'asio', 'device', new AbortController().signal, 'integer-direct', -2, 'online:netease:42');
    expect(api.request.mock.calls[0][0]).toMatchObject({ sourceMetadata });
});
it('does not transfer metadata belonging to a previous track with the same URL', async () => {
    const api = fixture(), src = 'https://example.com/stale-metadata', song = { id: 42 } as SongResult;
    rememberAudioSourceQuality(song, { url: src, fetchedAt: 0, quality: 'hires' });
    usePlaybackStore.setState({ audioSrc: src, currentSong: song });
    await loadNativeOnlineSource(api, 'metadata', src, 'asio', 'device', new AbortController().signal, 'integer-direct', -2, 'online:netease:43');
    expect(api.request.mock.calls[0][0]).not.toHaveProperty('sourceMetadata');
});
it.each(['https://example.com/spotify-session', 'blob:spotify-session'])('marks the matching session-bound source as non-cacheable for %s', async src => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))));
    const api = fixture(), song: SongResult = { id: 'spotify-track', name: 'Track', artists: [], album: { id: 'album', name: 'Album' }, durationMs: 200000, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'spotify-track', providerData: { sessionBoundAudio: true } } };
    usePlaybackStore.setState({ audioSrc: src, currentSong: song });
    await loadNativeOnlineSource(api, 'spotify', src, 'asio', 'device', new AbortController().signal, 'compatibility', -2, 'online:spotify:spotify-track');
    expect(api.request.mock.calls[0][0]).toHaveProperty('sessionBoundAudio', true);
});
it('does not borrow session-bound policy from the currently selected but unrelated song', async () => {
    const api = fixture(), src = 'https://example.com/stale-spotify';
    usePlaybackStore.setState({ audioSrc: src, currentSong: { id: 'new', name: 'Track', artists: [], album: { id: 'album', name: 'Album' }, durationMs: 200000, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'new', providerData: { sessionBoundAudio: true } } } });
    await loadNativeOnlineSource(api, 'old', src, 'asio', 'device', new AbortController().signal, 'compatibility', -2, 'online:spotify:old');
    expect(api.request.mock.calls[0][0]).not.toHaveProperty('sessionBoundAudio');
});
it.each([
    { audioSrc: 'https://example.com/other', durationMs: 123456, trackKey: 'online:netease:1' },
    { audioSrc: 'https://example.com/current', durationMs: 123456, trackKey: 'online:netease:2' },
    { audioSrc: 'https://example.com/current', durationMs: NaN, trackKey: 'online:netease:1' },
    { audioSrc: 'https://example.com/current', durationMs: 0, trackKey: 'online:netease:1' },
])('does not attach a stale or invalid duration hint ($trackKey, $durationMs)', async ({ audioSrc, durationMs, trackKey }) => {
    const api = fixture();
    usePlaybackStore.setState({ audioSrc, currentSong: { id: 1, durationMs } as SongResult });
    await loadNativeOnlineSource(api, 'song', 'https://example.com/current', 'asio', 'device', new AbortController().signal, 'integer-direct', -2, trackKey);
    expect(api.request.mock.calls[0][0]).not.toHaveProperty('duration');
});


it('passes the saved native handoff position into begin before source preparation', async () => {
    const api = fixture();
    await loadNativeOnlineSource(api, 'handoff', 'https://example.com/current', 'asio', 'device',
        new AbortController().signal, 'compatibility', -2, 'online:spotify:current', false, undefined, 37.25);
    expect(api.request.mock.calls[0][0]).toMatchObject({ action: 'begin', position: 37.25 });
    expect(api.request.mock.calls[1][0]).toEqual({ action: 'finish', session: 'handoff' });
});
