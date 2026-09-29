import { afterEach, expect, it, vi } from 'vitest';
import { prepareWithCompatibility } from '../../../src/services/nativeAudio/prepareWithCompatibility';
import { useDecodeCompatibilityStore } from '../../../src/stores/useDecodeCompatibilityStore';
import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad, usePlaybackLoadStore } from '../../../src/stores/usePlaybackLoadStore';

// User choices and progress packets must remain owned by the request that presented them.
afterEach(() => { useDecodeCompatibilityStore.getState().prompt?.choose('cancel'); useDecodeCompatibilityStore.setState({ enabled: false }); vi.unstubAllGlobals(); });
it('starts strict and keeps a one-song exception out of the persisted preference', async () => {
    expect(useDecodeCompatibilityStore.getState().enabled).toBe(false);
    const load = vi.fn().mockRejectedValueOnce({ code: 'STRICT_DECODE_FAILED' }).mockResolvedValue('audio');
    const result = prepareWithCompatibility('one', new AbortController().signal, load);
    await vi.waitFor(() => expect(useDecodeCompatibilityStore.getState().prompt).not.toBeNull());
    useDecodeCompatibilityStore.getState().prompt!.choose('once');
    expect(await result).toBe('audio'); expect(load.mock.calls).toEqual([[false], [true]]);
    expect(useDecodeCompatibilityStore.getState().enabled).toBe(false);
});
it('cancels a pending choice on song change without decoding the old song again', async () => {
    const controller = new AbortController(), error = { code: 'STRICT_DECODE_FAILED' };
    const load = vi.fn().mockRejectedValue(error);
    const result = prepareWithCompatibility('one', controller.signal, load).catch(value => value);
    await vi.waitFor(() => expect(useDecodeCompatibilityStore.getState().prompt).not.toBeNull());
    controller.abort(); expect(await result).toBe(error); expect(load).toHaveBeenCalledOnce();
    expect(useDecodeCompatibilityStore.getState().prompt).toBeNull();
});
it('persists only the explicit keep-enabled choice', async () => {
    const setItem = vi.fn(); vi.stubGlobal('window', {}); vi.stubGlobal('localStorage', { setItem });
    const load = vi.fn().mockRejectedValueOnce({ code: 'STRICT_DECODE_FAILED' }).mockResolvedValue('audio');
    const result = prepareWithCompatibility('one', new AbortController().signal, load);
    await vi.waitFor(() => expect(useDecodeCompatibilityStore.getState().prompt).not.toBeNull());
    useDecodeCompatibilityStore.getState().prompt!.choose('always'); await result;
    expect(useDecodeCompatibilityStore.getState().enabled).toBe(true); expect(setItem).toHaveBeenCalled();
});
it('ignores late progress and completion from superseded sessions', () => {
    beginPlaybackLoad('old', 'download'); beginPlaybackLoad('new', 'decode');
    updatePlaybackLoad('old', { stage: 'download', loaded: 100 }); endPlaybackLoad('old');
    expect(usePlaybackLoadStore.getState().progress?.stage).toBe('decode');
    endPlaybackLoad('new'); expect(usePlaybackLoadStore.getState().progress).toBeNull();
});
