import { create } from 'zustand';
import type { NativeAudioState } from '../types/nativeAudio';

// src/stores/useSignalPathStore.ts — format changes only; playback clocks never trigger React updates.
export type SignalSnapshot = Omit<NativeAudioState, 'position' | 'duration' | 'playing' | 'ended' | 'latency'>;
export const useSignalPathStore = create<{ snapshot: SignalSnapshot | null }>(() => ({ snapshot: null }));
export function publishSignalPath(state: NativeAudioState) {
    const { position, duration, playing, ended, latency, ...snapshot } = state;
    if (JSON.stringify(snapshot) !== JSON.stringify(useSignalPathStore.getState().snapshot))
        useSignalPathStore.setState({ snapshot });
}
export function clearSignalPath(session: string) {
    if (useSignalPathStore.getState().snapshot?.session === session) useSignalPathStore.setState({ snapshot: null });
}
