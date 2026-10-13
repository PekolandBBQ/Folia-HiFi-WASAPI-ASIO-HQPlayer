import { useEffect } from 'react';
import { useStore } from 'zustand';
import { spotifyPlaybackSetup, type SpotifyPlaybackSetupState } from '../services/onlineMusic/spotifyPlaybackSetup';

// Subscribers share one read-only pairing poller. Selectors let the palette
// observe availability without re-rendering the app for each download update.
export function useSpotifyPlaybackSetup<T>(selector: (state: SpotifyPlaybackSetupState) => T): T {
    useEffect(() => spotifyPlaybackSetup.activate(), []);
    return useStore(spotifyPlaybackSetup.store, selector);
}
