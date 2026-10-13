import type { SongResult } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// Prefer the completed original native download; its private file path stays in the main process.
export async function readNativeCachedSource(song: SongResult, src: string): Promise<string | null> {
    if (typeof window === 'undefined' || !window.electron?.nativeAudio?.supported) return null;
    try {
        const result = await window.electron.nativeAudio.request({ action: 'cached-source', url: src,
            trackKey: getPlaybackSongKey(song) }) as { url?: unknown } | null;
        if (typeof result?.url !== 'string') return null;
        const url = new URL(result.url);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
            && /^\/[a-f0-9]{48}\.wav$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
}
