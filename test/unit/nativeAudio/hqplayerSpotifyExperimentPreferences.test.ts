import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS as defaults, HQPLAYER_SPOTIFY_EXPERIMENT_KEY as key,
    normalizeHQPlayerSpotifyExperiment, readHQPlayerSpotifyExperiment } from '../../../src/utils/hqplayerSpotifyExperiment';

// test/unit/nativeAudio/hqplayerSpotifyExperimentPreferences.test.ts — stored timings cannot authorize unverified audio output.
let storage: Map<string, string>;
beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (name: string) => storage.get(name) ?? null,
        setItem: (name: string, value: string) => storage.set(name, value) });
});
afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

describe('HQPlayer Spotify experiment preferences', () => {
    it.each([undefined, null, false, true, 'true', [], [true], {}])('defaults malformed input %j to disabled, 350 / 0 ms', value => {
        expect(normalizeHQPlayerSpotifyExperiment(value)).toEqual(defaults);
    });
    it.each([undefined, null, false, 0, 1, 'true', 'false', '1', [], {}])('never coerces enabled=%j into consent', enabled => {
        expect(normalizeHQPlayerSpotifyExperiment({ enabled }).enabled).toBe(false);
    });
    it.each([undefined, null, true, false, '', '1500', 'Infinity', NaN, Infinity, -Infinity, [], {}])('rejects nonnumeric or nonfinite milliseconds %j', value => {
        expect(normalizeHQPlayerSpotifyExperiment({ enabled: true, prebufferMs: value, startupDelayMs: value }))
            .toEqual({ ...defaults, enabled: true });
    });
    it('clamps and rounds finite values to the backend integer contract', () => {
        expect(normalizeHQPlayerSpotifyExperiment({ enabled: true, prebufferMs: -2, startupDelayMs: -1 }))
            .toEqual({ enabled: true, prebufferMs: 100, startupDelayMs: 0 });
        expect(normalizeHQPlayerSpotifyExperiment({ prebufferMs: 50000, startupDelayMs: 9000 }))
            .toEqual({ enabled: false, prebufferMs: 2000, startupDelayMs: 1000 });
        expect(normalizeHQPlayerSpotifyExperiment({ prebufferMs: 749.6, startupDelayMs: 50.3 }))
            .toEqual({ enabled: false, prebufferMs: 750, startupDelayMs: 50 });
    });
    it.each(['{', 'null', 'true', '[]', '{"enabled":true}', '{"enabled":"true","prebufferMs":"1000","startupDelayMs":null}'])
        ('corrupt or obsolete stored data %s cannot enable the experiment', saved => {
            storage.set(key, saved);
            expect(readHQPlayerSpotifyExperiment()).toEqual(defaults);
        });
    it('reads valid stored timings but explicitly ignores persisted opt-in', () => {
        storage.set(key, '{"enabled":true,"prebufferMs":1500,"startupDelayMs":400}');
        expect(readHQPlayerSpotifyExperiment()).toEqual({ enabled: false, prebufferMs: 1500, startupDelayMs: 400 });
    });
    it('keeps opt-in in memory only, retains false preferences, and resets only experiment fields', async () => {
        storage.set('folia_hqplayer_silent_launch', 'false');
        storage.set('folia_hqplayer_remember_gain', 'false');
        const { useHQPlayerSettingsStore: store } = await import('../../../src/stores/useHQPlayerSettingsStore');
        expect(store.getState().spotifyExperiment).toEqual(defaults);
        store.getState().setGain(-12);
        store.getState().setSpotifyExperiment({ enabled: true, prebufferMs: 1250, startupDelayMs: 600 });
        expect(store.getState().spotifyExperiment.enabled).toBe(true);
        expect(JSON.parse(storage.get(key)!)).toEqual({ prebufferMs: 1250, startupDelayMs: 600 });
        vi.resetModules();
        const { useHQPlayerSettingsStore: reloaded } = await import('../../../src/stores/useHQPlayerSettingsStore');
        expect(reloaded.getState()).toMatchObject({ silentLaunch: false, remember: false, gainDb: -12,
            spotifyExperiment: { enabled: false, prebufferMs: 1250, startupDelayMs: 600 } });
        reloaded.getState().setSpotifyExperiment({ enabled: true });
        reloaded.getState().resetSpotifyExperiment();
        expect(reloaded.getState().spotifyExperiment).toEqual(defaults);
        expect(JSON.parse(storage.get(key)!)).toEqual({ prebufferMs: 350, startupDelayMs: 0 });
        expect(reloaded.getState()).toMatchObject({ silentLaunch: false, remember: false, gainDb: -12 });
    });
    it('normalizes changes before persistence without storing credentials or unrelated values', async () => {
        const { useHQPlayerSettingsStore: store } = await import('../../../src/stores/useHQPlayerSettingsStore');
        store.getState().setSpotifyExperiment({ enabled: 'true', prebufferMs: 9000, startupDelayMs: NaN } as never);
        expect(store.getState().spotifyExperiment).toEqual({ enabled: false, prebufferMs: 2000, startupDelayMs: 0 });
        expect([...storage.keys()]).toEqual([key]);
        expect(JSON.parse(storage.get(key)!)).toEqual({ prebufferMs: 2000, startupDelayMs: 0 });
    });
});
