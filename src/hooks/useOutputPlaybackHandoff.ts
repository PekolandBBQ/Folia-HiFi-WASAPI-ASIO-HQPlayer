import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { registerOutputHandoff } from '../services/nativeAudio/outputHandoff';
import { usePlaybackStore, setPlayerState } from '../stores/usePlaybackStore';
import { PlayerState } from '../types';
import type { NativeAudioBackend } from '../types/nativeAudio';
import { isNativeAudioElement, NativeAudioTransport } from '../services/nativeAudio/NativeAudioTransport';

// Transfer only the current source, after the new deck is ready. Neither warm decks nor later
// songs may consume a switch checkpoint; rapid switches retain the original playback intent.
export function useOutputPlaybackHandoff(audioRef: MutableRefObject<HTMLAudioElement | null>,
    backend: NativeAudioBackend, deviceId: string, source: string | null,
    pendingResumeTime: MutableRefObject<number | null>, autoPlay: MutableRefObject<boolean>) {
    const pending = useRef<{ backend: NativeAudioBackend; deviceId: string; source: string; position: number; playing: boolean; volume: number; muted: boolean } | null>(null);
    useLayoutEffect(() => registerOutputHandoff((nextBackend, nextDevice) => {
        const audio = audioRef.current;
        const currentSource = usePlaybackStore.getState().audioSrc;
        if (!audio || !currentSource || audio.getAttribute('src') !== currentSource || audio.error) return () => {};
        const previous = pending.current?.source === currentSource ? pending.current : null;
        const checkpoint = { backend: nextBackend, deviceId: nextDevice, source: currentSource, volume: audio.volume, muted: audio.muted,
            position: previous?.position ?? audio.currentTime,
            playing: previous?.playing ?? (!audio.paused || usePlaybackStore.getState().playerState === PlayerState.PLAYING) };
        pending.current = checkpoint;
        autoPlay.current = false;
        pendingResumeTime.current = checkpoint.position;
        audio.pause();
        return () => {
            if (pending.current !== checkpoint) return;
            pending.current = null; pendingResumeTime.current = null;
        };
    }), [audioRef, pendingResumeTime, autoPlay]);
    useLayoutEffect(() => {
        const checkpoint = pending.current, audio = audioRef.current;
        if (!checkpoint) return;
        if (checkpoint.source !== source) { pending.current = null; pendingResumeTime.current = null; return; }
        if (!audio || checkpoint.backend !== backend || checkpoint.deviceId !== deviceId) return;
        let canceled = false;
        const resume = () => queueMicrotask(() => {
            if (canceled || pending.current !== checkpoint || audioRef.current !== audio
                || usePlaybackStore.getState().audioSrc !== checkpoint.source || audio.error) return;
            pending.current = null; pendingResumeTime.current = null;
            audio.volume = checkpoint.volume; audio.muted = checkpoint.muted;
            const position = Math.min(checkpoint.position, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.25) : checkpoint.position);
            const restore = async () => {
                if (isNativeAudioElement(audio)) await (audio as unknown as NativeAudioTransport).resumeFrom(position, checkpoint.playing);
                else { audio.currentTime = position; if (checkpoint.playing) await audio.play(); }
            };
            void restore().catch(error => {
                if (audioRef.current === audio && error?.name !== 'AbortError') setPlayerState(PlayerState.PAUSED);
            });
            if (!checkpoint.playing) setPlayerState(PlayerState.PAUSED);
        });
        if (audio.readyState >= 1) resume();
        else audio.addEventListener('loadedmetadata', resume, { once: true });
        return () => { canceled = true; audio.removeEventListener('loadedmetadata', resume); };
    }, [backend, deviceId, source, audioRef, pendingResumeTime]);
}
