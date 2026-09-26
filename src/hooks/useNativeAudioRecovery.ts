import { useEffect, useRef, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { usePlaybackStore, setPlayerState } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { useNativeRecoveryStore, type NativeRecoveryChoice } from '../stores/useNativeRecoveryStore';
import { PlayerState } from '../types';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { getNativeErrorCode, nativeErrorKey } from '../services/nativeAudio/errors';
import { isNativeAudioElement, NativeAudioTransport } from '../services/nativeAudio/NativeAudioTransport';

const currentSongKey = () => { const song = usePlaybackStore.getState().currentSong; return song ? getPlaybackSongKey(song) : ''; };

// src/hooks/useNativeAudioRecovery.ts — one recovery decision per fatal session; no restart loop.
export function useNativeAudioRecovery(audioRef: MutableRefObject<HTMLAudioElement | null>, nativePlayback: boolean) {
    const { t } = useTranslation();
    const resume = useRef<{ song: string; position: number; playing: boolean } | null>(null);
    const generation = useRef(0);
    useEffect(() => {
        if (nativePlayback || !resume.current) return;
        const element = audioRef.current;
        if (!element || isNativeAudioElement(element)) return;
        const pending = resume.current;
        const apply = () => {
            if (resume.current !== pending) return;
            resume.current = null;
            if (currentSongKey() !== pending.song) return;
            element.currentTime = Number.isFinite(element.duration) ? Math.min(pending.position, element.duration) : pending.position;
            if (pending.playing) void element.play().catch(() => setPlayerState(PlayerState.PAUSED));
        };
        if (element.readyState >= 1) apply(); else element.addEventListener('loadedmetadata', apply, { once: true });
        return () => element.removeEventListener('loadedmetadata', apply);
    }, [nativePlayback, audioRef]);
    return (element: HTMLAudioElement): boolean => {
        const code = getNativeErrorCode(element.error);
        // Reuse the existing provider refresh/transcode recovery orchestration in App.
        if (['SOURCE_EXPIRED', 'SOURCE_UNAVAILABLE', 'DECODE_FAILED'].includes(code)) return false;
        const playing = usePlaybackStore.getState().playerState === PlayerState.PLAYING;
        setPlayerState(PlayerState.PAUSED);
        const fatal = code === 'COMPONENT_CRASHED' || code === 'COMPONENT_TIMEOUT';
        if (!fatal) { setStatusMessage({ type: 'error', text: t(nativeErrorKey(element.error)) }); return true; }
        const ticket = ++generation.current;
        const song = currentSongKey();
        const settings = useAudioSettingsStore.getState();
        const transport = element as unknown as NativeAudioTransport;
        const position = element.currentTime;
        const choose = async (choice: NativeRecoveryChoice) => {
            if (ticket !== generation.current || currentSongKey() !== song) {
                if (ticket === generation.current) useNativeRecoveryStore.setState({ errorCode: null, choose: null });
                return;
            }
            useNativeRecoveryStore.setState({ busy: true });
            try {
                await transport.stopForRecovery();
                if (ticket !== generation.current || currentSongKey() !== song) return;
                if (choice === 'browser') {
                    resume.current = { song, position, playing };
                    useAudioSettingsStore.getState().handleSetNativeAudioOutput('browser', '');
                    setStatusMessage({ type: 'error', text: `${t(nativeErrorKey(element.error))} ${t('nativeAudio.returnedToBrowser')}`, durationMs: 8000 });
                } else {
                    if (choice === 'rollback') await window.electron!.nativeAudio!.request({ action: 'component-rollback' });
                    if (ticket !== generation.current || currentSongKey() !== song) return;
                    await transport.retryFrom(position, playing);
                }
                if (ticket === generation.current) useNativeRecoveryStore.setState({ errorCode: null, choose: null });
            } catch (error) {
                if (ticket !== generation.current || currentSongKey() !== song) return;
                useNativeRecoveryStore.setState({ errorCode: getNativeErrorCode(error) });
                setStatusMessage({ type: 'error', text: t(nativeErrorKey(error)) });
            } finally {
                if (ticket === generation.current) useNativeRecoveryStore.setState({ busy: false,
                    ...(currentSongKey() !== song ? { errorCode: null, choose: null } : {}) });
            }
        };
        useNativeRecoveryStore.setState({ choose });
        if (settings.nativeAudioAutoFallback) {
            void choose('browser');
        } else useNativeRecoveryStore.setState({ errorCode: code });
        return true;
    };
}
