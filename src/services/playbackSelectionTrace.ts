import type { SongResult } from '../types';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
// Discrete intent events only: no media URLs, accounts or audio payloads.
let sequence = 0;
let origin: { id: number; source: string } | null = null;
export function selectionTrace(phase: string, song?: SongResult | null, detail: Record<string, unknown> = {}) {
    console.info('[PlaybackSelection]', JSON.stringify({ phase, ...origin,
        songKey: song ? getPlaybackSongKey(song) : null, title: song?.name ?? null, ...detail }));
}
export function withSelectionOrigin<T>(source: string, song: SongResult | undefined, action: () => T): T {
    const previous = origin; origin = previous ?? { id: ++sequence, source };
    selectionTrace('input', song, { entry: source });
    try { return action(); } finally { origin = previous; }
}
export function captureSelectionRequest() {
    return { ...origin, request: ++sequence, caller: new Error().stack?.split('\n').slice(2, 8)
        .map(line => line.replace(/(?:file:\/\/\/|https?:\/\/)[^\s)]*/g, '[renderer]')).join(' <- ') };
}
