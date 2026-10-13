import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLRC } from '../../utils/lyrics/parserCore';

// Normalize Spotify's own line lyrics without inferring word timing or instrumental status.
export function normalizeSpotifyLyrics(raw: unknown, trackId: string): ProviderLyricsResult {
    const empty: ProviderLyricsResult = { lyrics: null, mainText: null, isPureMusic: false };
    if (!raw || typeof raw !== 'object') return empty;
    const value = raw as { trackId?: string; source?: string; syncType?: string; lines?: unknown[] };
    if (value.trackId !== trackId || value.source !== 'spotify-native' || !Array.isArray(value.lines)) return empty;
    const rows = value.lines.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const row = entry as { startTimeMs?: unknown; words?: unknown };
        return typeof row.words === 'string' ? [{ text: row.words, ms: Number(row.startTimeMs) }] : [];
    });
    if (!rows.length) return empty;
    if (value.syncType !== 'LINE_SYNCED') return { ...empty, mainText: rows.map(row => row.text).join('\n') };
    const timed = rows.filter(row => Number.isFinite(row.ms) && row.ms >= 0);
    const mainText = timed.map(row => {
        const minutes = Math.floor(row.ms / 60000), seconds = ((row.ms % 60000) / 1000).toFixed(3).padStart(6, '0');
        return `[${String(minutes).padStart(2, '0')}:${seconds}]${row.text}`;
    }).join('\n');
    return mainText ? { lyrics: parseLRC(mainText), mainText, isPureMusic: false } : empty;
}
