import { create } from 'zustand';
import type { NativeAudioState } from '../types/nativeAudio';

// src/stores/useSignalPathStore.ts — format changes only; playback clocks never trigger React updates.
export type SignalSnapshot = Omit<NativeAudioState, 'position' | 'duration' | 'playing' | 'ended' | 'latency'>;
export const useSignalPathStore = create<{ snapshot: SignalSnapshot | null; owner: string; failureCode: string | null }>(() => ({ snapshot: null, owner: '', failureCode: null }));
export function beginSignalPath(session: string) {
    useSignalPathStore.setState({ owner: session, snapshot: null, failureCode: null });
}
export function failSignalPath(session: string, failureCode: string) {
    if (useSignalPathStore.getState().owner === session) useSignalPathStore.setState({ snapshot: null, failureCode });
}
export function publishSignalPath(state: NativeAudioState) {
    const { position, duration, playing, ended, latency, ...snapshot } = state;
    if (JSON.stringify(snapshot) !== JSON.stringify(useSignalPathStore.getState().snapshot))
        useSignalPathStore.setState({ snapshot, owner: state.session, failureCode: null });
}
export function clearSignalPath(session: string) {
    if (useSignalPathStore.getState().owner === session) useSignalPathStore.setState({ snapshot: null, owner: '', failureCode: null });
}
