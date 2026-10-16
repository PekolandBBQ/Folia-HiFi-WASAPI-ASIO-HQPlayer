import { create } from 'zustand';

// Only an unfinished marker survives restart. Account grants and personal keys
// remain in their existing main-process vaults; progress is re-read through Omni.
export const SPOTIFY_CONNECTION_PENDING_KEY = 'spotify_connection_pending';
type ConnectionState = { failureDetail?: string; open: boolean; pending: boolean; authorizeOnOpen: boolean; begin: () => void; dismiss: () => void; complete: () => void };
const readPending = () => {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(SPOTIFY_CONNECTION_PENDING_KEY) === 'true'; }
    catch { return false; }
};
const savePending = (pending: boolean) => {
    try {
        if (pending) localStorage.setItem(SPOTIFY_CONNECTION_PENDING_KEY, 'true');
        else localStorage.removeItem(SPOTIFY_CONNECTION_PENDING_KEY);
    } catch { /* A blocked preference store must not prevent connecting. */ }
};
const pending = readPending();
export const useSpotifyConnectionStore = create<ConnectionState>(set => ({
    open: false, pending, authorizeOnOpen: false,
    begin: () => { savePending(true); set({ open: true, pending: true, authorizeOnOpen: true, failureDetail: undefined }); },
    dismiss: () => set({ open: false, authorizeOnOpen: false }),
    complete: () => { savePending(false); set({ open: false, pending: false, authorizeOnOpen: false }); },
}));
