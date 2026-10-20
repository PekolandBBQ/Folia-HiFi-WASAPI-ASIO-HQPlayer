import { useEffect } from 'react';
import { useStore } from 'zustand';
import { spotifyPlaybackSetup, type SpotifyPlaybackSetupState } from '../services/onlineMusic/spotifyPlaybackSetup';
import { spotifyActivation } from '../services/onlineMusic/spotifyActivation';

// Subscribers share one read-only pairing poller. Selectors let the palette
// observe availability without re-rendering the app for each download update.
export function useSpotifyPlaybackSetup<T>(selector: (state: SpotifyPlaybackSetupState) => T): T {
    useEffect(() => {
        let release: (() => void) | undefined;
        const activate = () => { if (!release && spotifyActivation.selected()) release = spotifyPlaybackSetup.activate(); };
        activate(); const unsubscribe = spotifyActivation.subscribe(activate);
        return () => { unsubscribe(); release?.(); };
    }, []);
    return useStore(spotifyPlaybackSetup.store, selector);
}
