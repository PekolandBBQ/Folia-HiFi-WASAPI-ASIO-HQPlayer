import { useEffect, useRef, type MutableRefObject } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { setAudioSrc, setPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { PlayerState, type SongResult } from '../types';
import type { PlaybackNavigationOptions } from '../types/appPlayback';
import { spotifyReadiness } from '../services/onlineMusic/spotifyReadiness';

// React side of the main-process paused route handoff; normal metadata/playback stays in Omni.
export function useSpotifyDesktopHandoff(
    playSong: (song: SongResult, queue?: SongResult[], fm?: boolean, options?: PlaybackNavigationOptions) => Promise<void>,
    shouldAutoPlay: MutableRefObject<boolean>,
) {
    const play = useRef(playSong); play.current = playSong;
    useEffect(() => window.electron?.spotify?.onSetupRequired?.(() => { if (spotifyReadiness.state().status === 'ready') spotifyReadiness.reset(); void spotifyReadiness.run(); }), []);
    useEffect(() => {
        let revision = 0, disposed = false;
        const unsubscribe = window.electron?.spotify?.onExternalSelection?.(event => {
            const current = usePlaybackStore.getState().currentSong;
            const source = current && getPlaybackSourceRef(current);
            if (!current || source?.kind !== 'online' || source.providerId !== 'spotify') return;
            if (!/^[A-Za-z0-9]{22}$/.test(event.trackId) || !Number.isFinite(event.positionMs) || event.positionMs < 0) return;
            const intent = ++revision;
            shouldAutoPlay.current = false;
            setPlayerState(PlayerState.PAUSED); setAudioSrc(null);
            if (event.phase !== 'follow') return;
            void (async () => {
                const song = await omni.getSongDetail('spotify', event.trackId);
                if (!song || disposed || intent !== revision || usePlaybackStore.getState().currentSong !== current) return;
                await play.current(song, [song], false, { initialPosition: event.positionMs / 1000 });
            })().catch(() => setStatusMessage({ type: 'error', text: '无法追随 Spotify 当前歌曲，请重新选择歌曲。' }));
        });
        return () => { disposed = true; revision++; unsubscribe?.(); };
    }, [shouldAutoPlay]);
}
