import { useSpotifyHandoffStore } from '../stores/useSpotifyHandoffStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { hasPendingPlaybackSourceRequest } from '../services/playbackSourceRequest';
import { useSpotifyRepeatMode } from './useSpotifyRepeatMode';
import { useEffect, useRef, type MutableRefObject } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { setAudioSrc, setPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { PlayerState, type SongResult } from '../types';
import type { PlaybackNavigationOptions } from '../types/appPlayback';
import { spotifyReadiness } from '../services/onlineMusic/spotifyReadiness';
import { spotifyActivation } from '../services/onlineMusic/spotifyActivation';

// React side of the main-process paused route handoff; normal metadata/playback stays in Omni.
export function useSpotifyDesktopHandoff(
    playSong: (song: SongResult, queue?: SongResult[], fm?: boolean, options?: PlaybackNavigationOptions) => Promise<void>,
    shouldAutoPlay: MutableRefObject<boolean>,
    nextTrack: () => void,
) {
    useSpotifyRepeatMode();
    const play = useRef(playSong); play.current = playSong;
    const next = useRef(nextTrack); next.current = nextTrack;
    useEffect(() => window.electron?.spotify?.onSetupRequired?.(() => { if (!spotifyActivation.selected()) return; if (spotifyReadiness.state().status === 'ready') spotifyReadiness.reset(); void spotifyReadiness.run(); }), []);
    useEffect(() => {
        let revision = 0, disposed = false;
        const unsubscribe = window.electron?.spotify?.onExternalSelection?.(event => {
            if (event.phase === 'dismiss') {
                if (useSpotifyHandoffStore.getState().pending?.token === event.token) useSpotifyHandoffStore.setState({pending: null});
                return;
            }
            const current = usePlaybackStore.getState().currentSong;
            const source = current && getPlaybackSourceRef(current);
            if (!current || source?.kind !== 'online' || source.providerId !== 'spotify') return;
            if (hasPendingPlaybackSourceRequest() || (event.previousTrackId && event.previousTrackId !== source.mediaId)) return;
            if (!/^[A-Za-z0-9]{22}$/.test(event.trackId) || !Number.isFinite(event.positionMs) || event.positionMs < 0) return;
            const intent = ++revision;
            shouldAutoPlay.current = false;
            setPlayerState(PlayerState.PAUSED); setAudioSrc(null);
            if (event.phase === 'paused') {
                setStatusMessage(null);
                if ((!event.naturalEnd && !event.externalSeek && !event.externalPause && !event.externalResume) || event.error) useSpotifyHandoffStore.setState({pending: event});
                return;
            }
            useSpotifyHandoffStore.setState({pending: null});
            if (event.phase === 'advance') {
                if (useAudioSettingsStore.getState().loopMode !== 'one') { next.current(); return; }
                void play.current(current, usePlaybackStore.getState().playQueue, false, {initialPosition: 0, shouldNavigateToPlayer: false});
                return;
            }
            void (async () => {
                const song = event.externalSeek && source.mediaId === event.trackId ? current : await omni.getSongDetail('spotify', event.trackId);
                if (!song || disposed || intent !== revision || usePlaybackStore.getState().currentSong !== current) return;
                const queue = usePlaybackStore.getState().playQueue;
                const existing = queue.some(item => { const ref = getPlaybackSourceRef(item); return ref?.kind === 'online' && ref.mediaId === event.trackId && ref.providerId === 'spotify'; });
                await play.current(song, existing ? queue : [...queue, song], false, { initialPosition: event.positionMs / 1000, shouldNavigateToPlayer: false });
            })().catch(() => setStatusMessage({ type: 'error', text: '无法追随 Spotify 当前歌曲，请重新选择歌曲。' }));
        });
        return () => { disposed = true; revision++; unsubscribe?.(); };
    }, [shouldAutoPlay]);
}
