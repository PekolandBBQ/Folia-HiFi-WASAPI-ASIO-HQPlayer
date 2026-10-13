import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { omni } from '../services/onlineMusic/omni';
import { spotifyPlaybackSetup } from '../services/onlineMusic/spotifyPlaybackSetup';
import { getSpotifyConnectionStep } from '../services/onlineMusic/spotifyConnectionSteps';
import { useSpotifyConnectionStore } from '../stores/useSpotifyConnectionStore';
import { useOnlineProviderQrLogin } from './useOnlineProviderQrLogin';

// Catalog authorization is only the first step. One visible attempt owns every
// callback; dismissing or replacing it cannot complete/activate a late response.
export function useSpotifyConnection(onComplete: (isCurrent: () => boolean) => Promise<boolean>) {
    const { t } = useTranslation();
    const open = useSpotifyConnectionStore(state => state.open);
    const setup = useStore(spotifyPlaybackSetup.store);
    const [checking, setChecking] = useState(true);
    const [catalogAuthorized, setCatalogAuthorized] = useState(false);
    const [catalogVerifying, setCatalogVerifying] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [error, setError] = useState<'readFailed' | 'completeFailed' | null>(null);
    const generation = useRef(0), finishingOwner = useRef<number | null>(null);
    const completion = useRef(onComplete);
    completion.current = onComplete;
    const isCurrent = useCallback((owner: number) => generation.current === owner && useSpotifyConnectionStore.getState().open, []);
    const login = useOnlineProviderQrLogin({ providerId: 'spotify', t, onConfirmed: async () => {
        const owner = generation.current;
        setCatalogVerifying(true);
        try {
            const user = await omni.getLoginStatus('spotify');
            if (!isCurrent(owner)) return false;
            setCatalogAuthorized(Boolean(user));
            return Boolean(user);
        } catch { return false; }
        finally { if (isCurrent(owner)) setCatalogVerifying(false); }
    } });
    const { start, stop } = login;
    const inspect = useCallback(async () => {
        const owner = ++generation.current;
        stop(); setChecking(true); setCatalogVerifying(false); setError(null); setFinishing(false); finishingOwner.current = null;
        try {
            const [user, fresh] = await Promise.all([omni.getLoginStatus('spotify'), spotifyPlaybackSetup.refresh()]);
            if (!isCurrent(owner)) return;
            setCatalogAuthorized(Boolean(user));
            // A controller-owned startup survives dismissal. Its current status
            // is safe to resume while the main process finishes that same action.
            if (!fresh && !spotifyPlaybackSetup.store.getState().busy) { setError('readFailed'); return; }
            // A restart restores the guide, but only an explicit Connect click
            // starts a new browser authorization. Saved authorization is reused.
            const desktop = await window.electron?.spotify?.request({ action: 'desktopSetup', operation: 'status' }) as { enabled?: boolean } | undefined;
            if (!user && !desktop?.enabled && useSpotifyConnectionStore.getState().authorizeOnOpen) await start('spotify');
        } catch { if (isCurrent(owner)) setError('readFailed'); }
        finally { if (isCurrent(owner)) setChecking(false); }
    }, [isCurrent, start, stop]);
    useEffect(() => {
        if (!open) return;
        const release = spotifyPlaybackSetup.activate();
        void inspect();
        return () => { generation.current++; stop(); release(); };
    }, [open, inspect, stop]);
    const close = useCallback(() => {
        generation.current++; stop();
        // Closing the first-setup guide cancels its transient verification, not an already active player.
        if (['start', 'probe'].includes(spotifyPlaybackSetup.store.getState().operation || ''))
            void spotifyPlaybackSetup.run({ operation: 'stop' });
        useSpotifyConnectionStore.getState().dismiss();
    }, [stop]);
    const begin = useCallback(() => useSpotifyConnectionStore.getState().begin(), []);
    const finish = async () => {
        const owner = generation.current;
        if (finishingOwner.current != null || checking || !isCurrent(owner)
            || getSpotifyConnectionStep(catalogAuthorized, setup.status) !== 'ready') return;
        finishingOwner.current = owner; setFinishing(true); setError(null);
        try {
            const [user, fresh] = await Promise.all([omni.getLoginStatus('spotify'), spotifyPlaybackSetup.refresh()]);
            if (!isCurrent(owner)) return;
            setCatalogAuthorized(Boolean(user));
            if (!fresh) { setError('readFailed'); return; }
            if (!user || getSpotifyConnectionStep(true, spotifyPlaybackSetup.store.getState().status) !== 'ready') return;
            if (!await completion.current(() => isCurrent(owner))) {
                if (isCurrent(owner)) setError('completeFailed');
                return;
            }
            if (isCurrent(owner)) useSpotifyConnectionStore.getState().complete();
        } catch { if (isCurrent(owner)) setError('completeFailed'); }
        finally {
            if (finishingOwner.current === owner) {
                finishingOwner.current = null;
                if (isCurrent(owner)) setFinishing(false);
            }
        }
    };
    const finishDesktop = async () => {
        const owner = generation.current;
        if (finishingOwner.current != null || !isCurrent(owner)) return;
        finishingOwner.current = owner; setFinishing(true); setError(null);
        try {
            const desktop = await window.electron?.spotify?.request({ action: 'desktopSetup', operation: 'status' }) as { ready?: boolean } | undefined;
            const user = await omni.getLoginStatus('spotify');
            if (!isCurrent(owner)) return;
            if (!desktop?.ready || !user || !await completion.current(() => isCurrent(owner))) {
                if (isCurrent(owner)) setError('completeFailed');
                return;
            }
            if (isCurrent(owner)) useSpotifyConnectionStore.getState().complete();
        } catch { if (isCurrent(owner)) setError('completeFailed'); }
        finally { if (finishingOwner.current === owner) { finishingOwner.current = null; if (isCurrent(owner)) setFinishing(false); } }
    };
    return { open, begin, close, checking, catalogAuthorized, catalogVerifying, finishing, error, inspect, finish, finishDesktop, login, setup,
        step: getSpotifyConnectionStep(catalogAuthorized, setup.status) };
}
export type SpotifyConnection = ReturnType<typeof useSpotifyConnection>;
