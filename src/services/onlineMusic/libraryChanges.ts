import type { ProviderCollection } from '../../types/onlineMusic';

// Server-confirmed library snapshots; subscribers retain provider/account ownership checks.
export type OnlineLibraryChange = { providerId: string; accountId: string; kind: 'album' | 'artist'; id: string; subscribed: boolean; collections: ProviderCollection[] };
const listeners = new Set<(change: OnlineLibraryChange) => void>();
export const subscribeOnlineLibraryChanges = (listener: (change: OnlineLibraryChange) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
export const publishOnlineLibraryChange = (change: OnlineLibraryChange) => {
    for (const listener of listeners) {
        try { listener(change); } catch (error) { console.warn('[Library] Failed to refresh confirmed library snapshot', error); }
    }
};
