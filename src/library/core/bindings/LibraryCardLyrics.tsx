import { createContext, useContext, type ReactNode } from 'react';

// App supplies the existing lyric renderer; library cards only select by playback identity.
export const LibraryCardLyricsContext = createContext<{ songKey: string; content: ReactNode } | null>(null);
export function useLibraryCardLyrics(playbackKey?: string) {
    const value = useContext(LibraryCardLyricsContext);
    return playbackKey && value?.songKey === playbackKey ? value.content : null;
}
