import type { HQPlayerSpotifyExperimentSettings } from '../types/nativeAudio';

// src/utils/hqplayerSpotifyExperiment.ts — bounded preferences for an explicitly enabled, unverified live PCM test.
export const HQPLAYER_SPOTIFY_EXPERIMENT_KEY = 'folia_hqplayer_spotify_experiment';
export const HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS: Readonly<HQPlayerSpotifyExperimentSettings> = Object.freeze({
    enabled: false, prebufferMs: 350, startupDelayMs: 0,
});
// Legacy storage/wire range only. The shared livePcmPrebuffer preference owns every new stream target.
export const HQPLAYER_SPOTIFY_PREBUFFER_RANGE = Object.freeze({ min: 100, max: 2000, step: 50 });
export const HQPLAYER_SPOTIFY_STARTUP_DELAY_RANGE = Object.freeze({ min: 0, max: 1000, step: 50 });

const boundedMilliseconds = (value: unknown, fallback: number, range: { min: number; max: number }) =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(range.min, Math.min(range.max, value))) : fallback;

export function normalizeHQPlayerSpotifyExperiment(value: unknown): HQPlayerSpotifyExperimentSettings {
    const settings = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    return {
        enabled: settings.enabled === true,
        prebufferMs: boundedMilliseconds(settings.prebufferMs, HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS.prebufferMs, HQPLAYER_SPOTIFY_PREBUFFER_RANGE),
        startupDelayMs: boundedMilliseconds(settings.startupDelayMs, HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS.startupDelayMs, HQPLAYER_SPOTIFY_STARTUP_DELAY_RANGE),
    };
}

// Persisted data never grants opt-in: every app session must be enabled by the listener again.
export function readHQPlayerSpotifyExperiment(): HQPlayerSpotifyExperimentSettings {
    try {
        const saved = JSON.parse(localStorage.getItem(HQPLAYER_SPOTIFY_EXPERIMENT_KEY) || 'null');
        return { ...normalizeHQPlayerSpotifyExperiment(saved), enabled: false };
    } catch { return { ...HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS }; }
}

export function writeHQPlayerSpotifyExperiment(settings: HQPlayerSpotifyExperimentSettings) {
    if (typeof localStorage === 'undefined') return;
    const { prebufferMs, startupDelayMs } = normalizeHQPlayerSpotifyExperiment(settings);
    localStorage.setItem(HQPLAYER_SPOTIFY_EXPERIMENT_KEY, JSON.stringify({ prebufferMs, startupDelayMs }));
}
