import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { playbackFade } from '../services/playbackFade';
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { registerOutputHandoff, recordOutputHandoff } from '../services/nativeAudio/outputHandoff';
import { usePlaybackStore, setPlayerState, setAudioSrc } from '../stores/usePlaybackStore';
import { PlayerState } from '../types';
import type { NativeAudioBackend } from '../types/nativeAudio';
import { isNativeAudioElement, NativeAudioTransport } from '../services/nativeAudio/NativeAudioTransport';
import { nextPrivateDiagnosticRef } from '../services/debug/privateDiagnostics';
import { getNativeErrorCode } from '../services/nativeAudio/errors';
import type { PrivateNativeErrorCode } from '../types/privateDiagnostics';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { isSessionBoundAudio } from '../services/onlineMusic/audioPolicy';
import { cancelPlaybackSourceRequest } from '../services/playbackSourceRequest';

// r31 song/revision guards reconstructed from the authentic bundled client.
const currentSongKey = () => { const song = usePlaybackStore.getState().currentSong; return song ? getPlaybackSongKey(song) : null; };
type NativeIntent = ReturnType<NativeAudioTransport['getPlaybackIntent']>;
type Checkpoint = { backend: NativeAudioBackend; deviceId: string; source: string; songKey: string | number | null;
    outputRevision?: number; position: number; playing: boolean; volume: number; muted: boolean; diagnosticRef: number;
    outgoing: HTMLAudioElement; outgoingIntent: NativeIntent | null };
// A listener can pause/seek while HQPlayer is still releasing its device. Compare request
// identities captured after our own pause, including requests made while already paused.
function refreshCheckpointIntent(checkpoint: Checkpoint) {
    if (!checkpoint.outgoingIntent || !isNativeAudioElement(checkpoint.outgoing)) return;
    const intent = (checkpoint.outgoing as unknown as NativeAudioTransport).getPlaybackIntent();
    if (intent.playback !== checkpoint.outgoingIntent.playback) checkpoint.playing = intent.playback.playing;
    if (intent.seek && intent.seek !== checkpoint.outgoingIntent.seek) checkpoint.position = intent.seek.position;
    else checkpoint.position = Math.max(checkpoint.position, (checkpoint.outgoing as unknown as NativeAudioTransport).getOutputPosition());
}


// Transfer only the current source, after the new deck is ready. Neither warm decks nor later
// songs may consume a switch checkpoint; rapid switches retain the original playback intent.
export function useOutputPlaybackHandoff(audioRef: MutableRefObject<HTMLAudioElement | null>,
    backend: NativeAudioBackend, deviceId: string, source: string | null,
    pendingResumeTime: MutableRefObject<number | null>, autoPlay: MutableRefObject<boolean>, outputRevision?: number) {
    const pending = useRef<Checkpoint | null>(null);
    const restoring = useRef<{ checkpoint: NonNullable<typeof pending.current>; audio: HTMLAudioElement;
        intent: ReturnType<NativeAudioTransport['getPlaybackIntent']> | null } | null>(null);
    const latestDiagnosticRef = useRef(0);
    const [revision, setRevision] = useState(0);
    const ownershipGeneration = useRef(0);
    useLayoutEffect(() => {
        const generation = ++ownershipGeneration.current;
        return () => queueMicrotask(() => {
            // Keep StrictMode's synchronous replay; a real unmount retires every callback.
            if (ownershipGeneration.current !== generation) return;
            pending.current = null; restoring.current = null; pendingResumeTime.current = null;
            latestDiagnosticRef.current = 0;
        });
    }, [pendingResumeTime]);
    useLayoutEffect(() => registerOutputHandoff((nextBackend, nextDevice) => {
        const audio = audioRef.current;
        const currentSource = usePlaybackStore.getState().audioSrc;
        if (!audio || !currentSource || audio.getAttribute('src') !== currentSource) {
            recordOutputHandoff('rejected', { backend: nextBackend, reason: !audio ? 'no-deck' : !currentSource ? 'no-source' : 'source-mismatch' });
            return () => {};
        }
        // The outgoing output can have failed while still owning a valid song/position.
        // Changing output is itself a recovery action; only the target deck's error blocks resume.
        const fadingOut = playbackFade.isFadingOut();
        playbackFade.cancel();
        const songKey = currentSongKey();
        const active = restoring.current?.checkpoint.source === currentSource && restoring.current.checkpoint.songKey === songKey ? restoring.current : null;
        const previous = pending.current?.source === currentSource && pending.current.songKey === songKey ? pending.current : active?.checkpoint;
        if (previous) refreshCheckpointIntent(previous);
        // A native deck is temporarily paused during refill; only a newer control request
        // overrides retained intent. A pending checkpoint already includes our own output pause.
        const currentIntent = active?.audio === audio && active.intent
            ? (audio as unknown as NativeAudioTransport).getPlaybackIntent() : null;
        const previousPlaying = active && previous === active.checkpoint && currentIntent && currentIntent.playback !== active.intent?.playback
            ? currentIntent.playback.playing : previous?.playing;
        const previousPosition = active && previous === active.checkpoint && currentIntent?.seek && currentIntent.seek !== active.intent?.seek
            ? currentIntent.seek.position : previous?.position;
        const settings = useAudioSettingsStore.getState();
        const checkpoint: Checkpoint = { songKey, outputRevision: Number.isInteger(settings.nativeAudioOutputRevision) ? settings.nativeAudioOutputRevision + 1 : undefined,
            outgoing: audio, outgoingIntent: null, diagnosticRef: nextPrivateDiagnosticRef(), backend: nextBackend, deviceId: nextDevice, source: currentSource, volume: settings.volume, muted: settings.isMuted,
            position: previousPosition ?? (isNativeAudioElement(audio) ? (audio as unknown as NativeAudioTransport).getOutputPosition() : audio.currentTime),
            playing: previousPlaying ?? (!fadingOut && (!audio.paused || usePlaybackStore.getState().playerState === PlayerState.PLAYING)) };
        pending.current = checkpoint;
        latestDiagnosticRef.current = checkpoint.diagnosticRef;
        recordOutputHandoff('captured', { sessionRef: checkpoint.diagnosticRef, backend: nextBackend, position: checkpoint.position, playing: checkpoint.playing,
            reason: audio.error ? 'outgoing-error-retained' : undefined });
        autoPlay.current = false;
        pendingResumeTime.current = checkpoint.position;
        const song = usePlaybackStore.getState().currentSong;
        if (audio.error && song && isSessionBoundAudio(song)) {
            cancelPlaybackSourceRequest(); pending.current = null; restoring.current = null;
            setPlayerState(PlayerState.PAUSED); setAudioSrc(null);
            recordOutputHandoff('deferred', { sessionRef: checkpoint.diagnosticRef, backend: nextBackend, position: checkpoint.position, playing: false, reason: 'deck-error' });
            return () => {};
        }
        audio.pause();
        checkpoint.outgoingIntent = isNativeAudioElement(audio) ? (audio as unknown as NativeAudioTransport).getPlaybackIntent() : null;
        // Batched selections may end at the already mounted backend. Reconcile even when
        // React sees no backend/device change, or that original deck remains paused forever.
        setRevision(value => value + 1);
        return () => {
            if (pending.current !== checkpoint) return;
            recordOutputHandoff('cancelled', { sessionRef: checkpoint.diagnosticRef, backend: checkpoint.backend, position: checkpoint.position });
            pending.current = null; pendingResumeTime.current = null;
        };
    }, requestedSource => {
        const checkpoint = pending.current;
        if (!checkpoint || checkpoint.source !== requestedSource || checkpoint.songKey !== currentSongKey()) return false;
        refreshCheckpointIntent(checkpoint);
        return !checkpoint.playing;
    }), [audioRef, pendingResumeTime, autoPlay]);
    useLayoutEffect(() => {
        const checkpoint = pending.current, audio = audioRef.current;
        if (!checkpoint) return;
        if (checkpoint.source !== source || checkpoint.songKey !== currentSongKey()) { recordOutputHandoff('discarded', { sessionRef: checkpoint.diagnosticRef, reason: 'source-changed' }); pending.current = null; pendingResumeTime.current = null; return; }
        if (!audio || checkpoint.backend !== backend || checkpoint.deviceId !== deviceId || (outputRevision !== undefined && checkpoint.outputRevision !== outputRevision)) {
            recordOutputHandoff('waiting', { sessionRef: checkpoint.diagnosticRef, backend, reason: !audio ? 'no-deck' : 'output-not-committed' }); return;
        }
        let canceled = false;
        const resume = () => queueMicrotask(() => {
            if (canceled || pending.current !== checkpoint || audioRef.current !== audio
                || usePlaybackStore.getState().audioSrc !== checkpoint.source || checkpoint.songKey !== currentSongKey() || audio.error) {
                recordOutputHandoff('deferred', { sessionRef: checkpoint.diagnosticRef, backend, reason: canceled ? 'effect-replaced' : pending.current !== checkpoint ? 'checkpoint-replaced' : audioRef.current !== audio ? 'deck-replaced' : audio.error ? 'deck-error' : 'source-changed' }); return;
            }
            refreshCheckpointIntent(checkpoint);
            recordOutputHandoff('restoring', { sessionRef: checkpoint.diagnosticRef, backend, position: checkpoint.position, playing: checkpoint.playing });
            // A streaming seek/play can still be waiting after metadata. Keep its original
            // checkpoint available to the next output switch without scheduling it twice.
            restoring.current = { checkpoint, audio, intent: isNativeAudioElement(audio)
                ? (audio as unknown as NativeAudioTransport).getPlaybackIntent() : null };
            pending.current = null; pendingResumeTime.current = null;
            audio.volume = checkpoint.volume; audio.muted = checkpoint.muted;
            const position = Math.min(checkpoint.position, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.25) : checkpoint.position);
            const restore = async () => {
                if (isNativeAudioElement(audio)) await (audio as unknown as NativeAudioTransport).resumeFrom(position, checkpoint.playing);
                else { audio.currentTime = position; if (checkpoint.playing) await audio.play(); }
            };
            void restore().then(() => {
                // A successful old promise must not claim that a newer deck or checkpoint resumed.
                const staleReason = canceled ? 'effect-replaced' : latestDiagnosticRef.current !== checkpoint.diagnosticRef ? 'checkpoint-replaced'
                    : audioRef.current !== audio ? 'deck-replaced' : usePlaybackStore.getState().audioSrc !== checkpoint.source || checkpoint.songKey !== currentSongKey() ? 'source-changed' : null;
                if (staleReason) recordOutputHandoff('deferred', { sessionRef: checkpoint.diagnosticRef, backend, reason: staleReason });
                else recordOutputHandoff('restored', { sessionRef: checkpoint.diagnosticRef, backend, position: audio.currentTime, playing: !audio.paused });
            }).catch(error => {
                recordOutputHandoff('restore-failed', { sessionRef: checkpoint.diagnosticRef, backend, position,
                    playing: checkpoint.playing, reason: error?.name === 'AbortError' ? 'restore-aborted' : 'restore-rejected',
                    errorCode: error?.name === 'AbortError' ? 'CANCELLED' : getNativeErrorCode(error) as PrivateNativeErrorCode });
                if (!canceled && latestDiagnosticRef.current === checkpoint.diagnosticRef && audioRef.current === audio
                    && usePlaybackStore.getState().audioSrc === checkpoint.source && checkpoint.songKey === currentSongKey() && error?.name !== 'AbortError') setPlayerState(PlayerState.PAUSED);
            }).finally(() => { if (restoring.current?.checkpoint === checkpoint) restoring.current = null; });
            if (!checkpoint.playing) setPlayerState(PlayerState.PAUSED);
        });
        const onIntentChange = () => {
            if (pending.current !== checkpoint || !isNativeAudioElement(audio)) return;
            const intent = (audio as unknown as NativeAudioTransport).getPlaybackIntent();
            checkpoint.playing = intent.playback.playing;
            if (!checkpoint.playing) { checkpoint.position = (audio as unknown as NativeAudioTransport).getOutputPosition(); resume(); }
        };
        audio.addEventListener('playbackintentchange', onIntentChange);
        refreshCheckpointIntent(checkpoint);
        if (audio.readyState >= 1 || (isNativeAudioElement(audio) && !checkpoint.playing)) resume();
        else { recordOutputHandoff('waiting', { sessionRef: checkpoint.diagnosticRef, backend, reason: 'metadata' }); audio.addEventListener('loadedmetadata', resume, { once: true }); }
        return () => {
            canceled = true; audio.removeEventListener('loadedmetadata', resume);
            audio.removeEventListener('playbackintentchange', onIntentChange);
            if (restoring.current?.checkpoint === checkpoint) restoring.current = null;
        };
    }, [backend, deviceId, source, audioRef, pendingResumeTime, revision, outputRevision]);
    // Metadata also serves ordinary URL/session recovery in App. During an output switch this
    // hook owns seek-and-play; a second metadata setter would reset streaming beneath its controls.
    return () => Boolean(pending.current && pending.current.source === usePlaybackStore.getState().audioSrc && pending.current.songKey === currentSongKey());
}
