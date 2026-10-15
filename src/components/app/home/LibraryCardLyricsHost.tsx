import NoLyricsNotice from '../NoLyricsNotice';
import { useNativeLyricsResultStore } from '../../../stores/useNativeLyricsResultStore';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useReducedMotionFor } from '../../../hooks/useReducedMotionFor';
import type { SongResult } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { LibraryCardLyricsContext } from '../../../library/core/bindings/LibraryCardLyrics';
import LatticeLyricsProvider from '../lattice/lyrics/LatticeLyricsProvider';
import type { LatticeLyricSource } from '../lattice/lyrics/types';

// Reuse the queue collage clock, renderer and fallback without coupling library core to the app.
const Lyrics = lazy(() => import('../lattice/lyrics/LatticeLyrics'));
export default function LibraryCardLyricsHost({ song, source, keywordColoringEnabled, children }: {
    song: SongResult | null; source: LatticeLyricSource; keywordColoringEnabled: boolean; children: ReactNode;
}) {
    const empty = useNativeLyricsResultStore(state => Boolean(song && state.songKey === getPlaybackSongKey(song) && state.state === 'empty'));
    const reducedMotion = useReducedMotionFor('lattice');
    const value = useMemo(() => {
        if (!song) return null;
        const songKey = getPlaybackSongKey(song);
        if (!source.lines.some(line => line.fullText.trim())) return empty ? { songKey, content: <NoLyricsNotice songKey={songKey} card /> } : null;
        return { songKey, content: <LatticeLyricsProvider source={source} songKey={songKey} keywordColoringEnabled={keywordColoringEnabled}>
            <Suspense fallback={null}><Lyrics tile={{ id: songKey, song, title: song.name, artist: '', queueIndex: 0, section: 'now' }}
                reducedMotion={reducedMotion} showMetadata={false} /></Suspense>
        </LatticeLyricsProvider> };
    }, [song, source, keywordColoringEnabled, reducedMotion, empty]);
    return <LibraryCardLyricsContext.Provider value={value}>{children}</LibraryCardLyricsContext.Provider>;
}
