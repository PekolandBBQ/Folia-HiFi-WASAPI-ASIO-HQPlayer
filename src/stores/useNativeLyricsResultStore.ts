import { create } from 'zustand';

// Presentation only: never label the song as instrumental or interfere with playback.
type Result = { songKey: string | null; state: 'loading' | 'empty' | 'ready' | 'error' };
export const useNativeLyricsResultStore = create<Result>(() => ({ songKey: null, state: 'loading' }));
