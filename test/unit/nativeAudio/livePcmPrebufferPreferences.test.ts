import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { LIVE_PCM_PREBUFFER_KEY as key, LIVE_PCM_PREBUFFER_DEFAULT_MS, normalizeLivePcmPrebufferMs, readLivePcmPrebufferMs, writeLivePcmPrebufferMs } from '../../../src/utils/livePcmPrebuffer';

// Renderer persistence/migration and strict main/stream boundaries share one integer contract.
const { validateLivePcmPrebufferMs, DEFAULT_LIVE_PCM_PREBUFFER_MS } = createRequire(import.meta.url)('../../../electron/nativeAudio/livePcmPrebuffer.cjs');
const legacy = 'folia_hqplayer_spotify_experiment';
let saved: Map<string, string>;
beforeEach(() => { saved = new Map(); vi.stubGlobal('localStorage', { getItem: (name: string) => saved.get(name) ?? null, setItem: (name: string, value: string) => saved.set(name, value) }); });
afterEach(() => vi.unstubAllGlobals());
it('keeps the measured baseline at 350 ms in renderer and main', () => {
    expect(LIVE_PCM_PREBUFFER_DEFAULT_MS).toBe(350); expect(DEFAULT_LIVE_PCM_PREBUFFER_MS).toBe(350);
    expect(readLivePcmPrebufferMs()).toBe(350); expect(validateLivePcmPrebufferMs()).toBe(350);
});
it.each([25, 350, 1000, 5000])('persists and reloads the exact integer %i ms', value => {
    expect(writeLivePcmPrebufferMs(value)).toBe(value); expect(saved.get(key)).toBe(String(value));
    expect(readLivePcmPrebufferMs()).toBe(value); expect(validateLivePcmPrebufferMs(value)).toBe(value);
});
it.each([100, 350, 749, 1000, 1500, 2000])('migrates legacy HQ %i ms once, within the 5000 ms maximum', value => {
    saved.set(legacy, JSON.stringify({ enabled: true, prebufferMs: value, startupDelayMs: 450 }));
    expect(readLivePcmPrebufferMs()).toBe(Math.min(5000, value));
    expect(saved.get(key)).toBe(String(Math.min(5000, value)));
    writeLivePcmPrebufferMs(25); saved.set(legacy, '{"prebufferMs":350,"startupDelayMs":0}');
    expect(readLivePcmPrebufferMs()).toBe(25);
});
it.each(['{', 'null', '[]', '{}', '{"prebufferMs":"750"}', '{"prebufferMs":75}', '{"prebufferMs":9999}'])('defaults corrupt legacy input %s', value => {
    saved.set(legacy, value); expect(readLivePcmPrebufferMs()).toBe(350);
});
it.each([NaN, Infinity, null, true, '25', {}, []])('does not coerce invalid renderer input %j and rejects IPC', value => {
    expect(normalizeLivePcmPrebufferMs(value)).toBe(350); expect(() => validateLivePcmPrebufferMs(value)).toThrow();
});
it.each([[0, 25], [24.5, 25], [350.6, 351], [5001, 5000]])('bounds renderer %i to %i but rejects its raw IPC representation', (value, bounded) => {
    expect(writeLivePcmPrebufferMs(value)).toBe(bounded); expect(() => validateLivePcmPrebufferMs(value)).toThrow();
});
it('survives storage denial and malformed canonical data without reviving the old HQ setting', () => {
    saved.set(key, 'null'); saved.set(legacy, '{"prebufferMs":1000}'); expect(readLivePcmPrebufferMs()).toBe(350);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readLivePcmPrebufferMs()).toBe(350); expect(writeLivePcmPrebufferMs(25)).toBe(25);
});
it.each(['25.5', '24', '5001', '"750"', 'true', '{}', '[]', 'null', 'NaN'])('defaults invalid canonical storage %s without coercion or legacy revival', value => {
    saved.set(key, value); saved.set(legacy, '{"prebufferMs":1000}'); expect(readLivePcmPrebufferMs()).toBe(350);
});
it.each([350, 749, 1500])('initializes the real store from saved HQ %i and retains its chosen value after reload', async value => {
    saved.set(legacy, JSON.stringify({ prebufferMs: value, startupDelayMs: 400 }));
    vi.resetModules();
    const { useAudioSettingsStore: initial } = await import('../../../src/stores/useAudioSettingsStore');
    expect(initial.getState().livePcmPrebufferMs).toBe(Math.min(value, 5000));
    initial.getState().handleSetLivePcmPrebufferMs(25);
    saved.set(legacy, '{"prebufferMs":350,"startupDelayMs":0}');
    vi.resetModules();
    const { useAudioSettingsStore: reloaded } = await import('../../../src/stores/useAudioSettingsStore');
    expect(reloaded.getState().livePcmPrebufferMs).toBe(25);
});
it('rejects invalid per-generation targets before opening a stream or decoding PCM', () => {
    const { createStreamSession } = createRequire(import.meta.url)('../../../electron/nativeAudio/streamSession.cjs');
    const helper = { request: vi.fn() }, decode = vi.fn();
    const session = createStreamSession({ current: { id: 'validation', abort: new AbortController() }, helper,
        sourceFactory: () => ({ state: { complete: false }, downloaded: Promise.resolve() }),
        decode, progress: vi.fn(), assertCurrent: vi.fn(), onError: vi.fn(), getPrebufferMs: () => 24 });
    expect(() => session.prepare()).toThrow('25 to 5000'); expect(helper.request).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
});
