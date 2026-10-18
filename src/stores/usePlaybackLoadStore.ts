import { create } from 'zustand';

// Session-owned preparation telemetry; late packets cannot replace the current song's progress.
export type LoadStage = 'spotifyLaunch' | 'spotifyHandshake' | 'spotifyReady' | 'cache' | 'inspect' | 'source' | 'download' | 'upload' | 'decode' | 'validate' | 'connect' | 'load' | 'buffer';
export type LoadProgress = { preparationRevision?: number; stage: LoadStage; loaded?: number; total?: number; elapsedMs?: number; unit?: 'bytes' | 'milliseconds' | 'items'; complete?: boolean;
    startupDelayMs?: number; startupElapsedMs?: number };
export const usePlaybackLoadStore = create<{ owner: string; startedAt: number; progress: LoadProgress | null; preparationRevision: number }>(() => ({ owner: '', startedAt: 0, progress: null, preparationRevision: 0 }));
export function beginPlaybackLoad(owner: string, stage: LoadStage) { usePlaybackLoadStore.setState({ owner, startedAt: Date.now(), progress: { stage }, preparationRevision: 0 }); }
export function updatePlaybackLoad(owner: string, progress: LoadProgress) {
    const state = usePlaybackLoadStore.getState();
    if (state.owner !== owner) return;
    const revision = progress.preparationRevision;
    if (revision === undefined ? state.preparationRevision > 0 : !Number.isSafeInteger(revision) || revision < state.preparationRevision) return;
    usePlaybackLoadStore.setState({ progress, ...(revision !== undefined ? { preparationRevision: revision } : {}) });
}
export function endPlaybackLoad(owner: string) {
    if (usePlaybackLoadStore.getState().owner === owner) usePlaybackLoadStore.setState({ owner: '', progress: null });
}
