// src/utils/livePcmPrebuffer.ts — one saved target for Spotify live PCM on every native output.
export const LIVE_PCM_PREBUFFER_KEY = 'folia_live_pcm_prebuffer_ms';
export const LIVE_PCM_PREBUFFER_DEFAULT_MS = 350;
export const LIVE_PCM_PREBUFFER_RANGE = Object.freeze({ min: 25, max: 1000, step: 1 });
const legacyKey = 'folia_hqplayer_spotify_experiment';

export const normalizeLivePcmPrebufferMs = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(25, Math.min(1000, value))) : LIVE_PCM_PREBUFFER_DEFAULT_MS;

// Promote a valid legacy HQ timing once. The canonical preference always wins, even after an HQ reset.
export function readLivePcmPrebufferMs(): number {
    try {
        const saved = localStorage.getItem(LIVE_PCM_PREBUFFER_KEY);
        if (saved !== null) {
            const value = JSON.parse(saved);
            return Number.isInteger(value) && value >= 25 && value <= 1000 ? value : LIVE_PCM_PREBUFFER_DEFAULT_MS;
        }
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || 'null');
        const value = legacy && !Array.isArray(legacy) && typeof legacy === 'object'
            && Number.isInteger(legacy.prebufferMs) && legacy.prebufferMs >= 100 && legacy.prebufferMs <= 2000
            ? normalizeLivePcmPrebufferMs(legacy.prebufferMs) : LIVE_PCM_PREBUFFER_DEFAULT_MS;
        localStorage.setItem(LIVE_PCM_PREBUFFER_KEY, String(value));
        return value;
    } catch { return LIVE_PCM_PREBUFFER_DEFAULT_MS; }
}

export function writeLivePcmPrebufferMs(value: unknown): number {
    const normalized = normalizeLivePcmPrebufferMs(value);
    try { localStorage.setItem(LIVE_PCM_PREBUFFER_KEY, String(normalized)); } catch { /* Keep the in-session preference if storage is unavailable. */ }
    return normalized;
}
