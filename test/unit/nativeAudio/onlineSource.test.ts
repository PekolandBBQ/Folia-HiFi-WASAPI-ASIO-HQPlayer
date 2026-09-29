import { afterEach, expect, it, vi } from 'vitest';
import { loadNativeOnlineSource } from '../../../src/services/nativeAudio/loadOnlineSource';
import type { NativeAudioApi } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/onlineSource.test.ts — preserve the resolved quality URL and cache bytes.
afterEach(() => vi.unstubAllGlobals());
function fixture() {
    const request = vi.fn(async (_request: Parameters<NativeAudioApi['request']>[0]) => ({}));
    return { supported: true, request, onEvent: vi.fn() } as NativeAudioApi & { request: typeof request };
}
it('passes the exact quality-selected URL to the host, without resolving it again', async () => {
    const api = fixture();
    const url = 'https://example.com/track?quality=hires&signature=unchanged';
    await loadNativeOnlineSource(api, 'online', url, 'asio', 'device', new AbortController().signal, 'integer-direct');
    expect(api.request.mock.calls.map(([request]) => request)).toEqual([
        { action: 'begin', silent: false, session: 'online', url, compatibilityMode: false, backend: 'asio', deviceId: 'device', processingMode: 'integer-direct' },
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
