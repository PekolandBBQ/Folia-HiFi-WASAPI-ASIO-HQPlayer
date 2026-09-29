import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { reopenAfterHQPlayer } = createRequire(import.meta.url)('../../../electron/nativeAudio/reopenAfterHQPlayer.cjs');
const unavailable = Object.assign(new Error('driver reset'), { code: 'DEVICE_UNAVAILABLE' });
it('reopens the same output after a transient DSD-to-PCM invalidation', async () => {
    const load = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue({ playing: false });
    const wait = vi.fn(async () => {}), onRetry = vi.fn();
    await expect(reopenAfterHQPlayer(load, { recovering: true, signal: new AbortController().signal, wait, onRetry })).resolves.toEqual({ playing: false });
    expect(load).toHaveBeenCalledTimes(2); expect(onRetry).toHaveBeenCalledOnce();
});
it('bounds a persistent driver failure and does not retry unrelated errors or ordinary loads', async () => {
    const load = vi.fn().mockRejectedValue(unavailable), wait = vi.fn(async () => {});
    await expect(reopenAfterHQPlayer(load, { recovering: true, signal: new AbortController().signal, wait })).rejects.toBe(unavailable);
    expect(load).toHaveBeenCalledTimes(4);
    load.mockClear();
    await expect(reopenAfterHQPlayer(load, { recovering: false, signal: new AbortController().signal, wait })).rejects.toBe(unavailable);
    expect(load).toHaveBeenCalledOnce();
    const format = Object.assign(new Error('format'), { code: 'FORMAT_UNSUPPORTED' }); load.mockClear().mockRejectedValue(format);
    await expect(reopenAfterHQPlayer(load, { recovering: true, signal: new AbortController().signal, wait })).rejects.toBe(format);
    expect(load).toHaveBeenCalledOnce();
});
it('cancels a superseded handoff before it can reopen the driver', async () => {
    const controller = new AbortController(), load = vi.fn().mockRejectedValue(unavailable);
    const wait = async () => { controller.abort(); };
    await expect(reopenAfterHQPlayer(load, { recovering: true, signal: controller.signal, wait })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(load).toHaveBeenCalledOnce();
});
