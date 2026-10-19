import { create } from 'zustand';

// A visible choice is tied to the main-process handoff token, not an old error toast.
export type SpotifyHandoff = { token: number; trackId: string; positionMs: number; name?: string; error?: string };
export const useSpotifyHandoffStore = create<{pending: SpotifyHandoff | null}>(() => ({pending: null}));
