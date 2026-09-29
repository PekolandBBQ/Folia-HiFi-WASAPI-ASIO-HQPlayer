import { create } from 'zustand';

// Session-owned preparation telemetry; late packets cannot replace the current song's progress.
export type LoadStage = 'cache' | 'inspect' | 'source' | 'download' | 'upload' | 'decode' | 'validate' | 'connect' | 'load' | 'buffer';
export type LoadProgress = { stage: LoadStage; loaded?: number; total?: number; elapsedMs?: number };
export const usePlaybackLoadStore = create<{ owner: string; startedAt: number; progress: LoadProgress | null }>(() => ({ owner: '', startedAt: 0, progress: null }));
export function beginPlaybackLoad(owner: string, stage: LoadStage) { usePlaybackLoadStore.setState({ owner, startedAt: Date.now(), progress: { stage } }); }
export function updatePlaybackLoad(owner: string, progress: LoadProgress) {
    if (usePlaybackLoadStore.getState().owner === owner) usePlaybackLoadStore.setState({ progress });
}
export function endPlaybackLoad(owner: string) {
    if (usePlaybackLoadStore.getState().owner === owner) usePlaybackLoadStore.setState({ progress: null });
}
