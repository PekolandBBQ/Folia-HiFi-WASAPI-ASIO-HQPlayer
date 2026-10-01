import { afterEach, expect, it, vi } from 'vitest';
import { getHQPlayerDspCache, readHQPlayerDsp, setHQPlayerDspSession, invalidateHQPlayerDsp } from '../../../src/services/nativeAudio/hqplayerDspCache';
import type { HQPlayerDspCatalog } from '../../../src/types/hqplayerDsp';

// Prewarming must share work, discard stale sessions and permit retry after an IPC failure.
afterEach(() => { invalidateHQPlayerDsp(); vi.unstubAllGlobals(); });
const data = { state: { mode: 1 }, catalogs: {} } as HQPlayerDspCatalog;
it('shares prewarming with the open editor and ignores an old session reply', async () => {
    let finish!: (data: HQPlayerDspCatalog) => void;
    const request = vi.fn(() => new Promise<HQPlayerDspCatalog>(resolve => { finish = resolve; }));
    vi.stubGlobal('window', { electron: { nativeAudio: { request } } });
    setHQPlayerDspSession('one');
    const first = readHQPlayerDsp();
    expect(readHQPlayerDsp()).toBe(first);
    setHQPlayerDspSession('two');
    finish(data); await first;
    expect(getHQPlayerDspCache()).toBeNull();
    const next = readHQPlayerDsp(); finish(data); await next;
    expect(getHQPlayerDspCache()).toBe(data);
    expect(request).toHaveBeenCalledTimes(2);
});
it('keeps complete cached data during refresh and retries failed reads', async () => {
    const request = vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce(data);
    vi.stubGlobal('window', { electron: { nativeAudio: { request } } });
    await readHQPlayerDsp();
    await expect(readHQPlayerDsp()).rejects.toThrow('disconnected');
    expect(getHQPlayerDspCache()).toBe(data);
    await readHQPlayerDsp();
    expect(request).toHaveBeenCalledTimes(3);
});
