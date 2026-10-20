import { useEffect, useRef } from 'react';
import { spotifyReadiness } from '../services/onlineMusic/spotifyReadiness';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { useCollectionNavigationStore } from '../stores/useCollectionNavigationStore';
import { useSpotifyConnectionStore } from '../stores/useSpotifyConnectionStore';
import { spotifyActivation } from '../services/onlineMusic/spotifyActivation';
// Background failure never opens a modal; only a still-current Spotify playlist click can do so.
export function useSpotifyStartupCheck() {
    const user = useOnlineProviderAccountStore(state => state.accounts.spotify?.user?.id);
    const previousUser = useRef(user);
    useEffect(() => {
        if (previousUser.current !== user) { spotifyReadiness.reset(); previousUser.current = user; }
        const check = () => { if (user && spotifyActivation.selected()) void spotifyReadiness.run(); };
        check();
        return spotifyActivation.subscribe(check);
    }, [user]);
    useEffect(() => useCollectionNavigationStore.subscribe((state, previous) => {
        if (state.snapshot === previous.snapshot) return;
        const collection = state.snapshot?.stack.at(-1);
        if (collection?.source !== 'online' || collection.providerId !== 'spotify') return;
        spotifyActivation.select();
        if (collection.type !== 'playlist') return;
        void (async () => {
            if (spotifyReadiness.state().status === 'failed') spotifyReadiness.reset();
            const result = await spotifyReadiness.run();
            const active = useCollectionNavigationStore.getState().snapshot?.stack.at(-1);
            if (result || active?.source !== 'online' || active.providerId !== 'spotify' || String(active.id) !== String(collection.id)) return;
            const failure = spotifyReadiness.state();
            if (failure.status === 'failed' && failure.retries === 3) {
                useSpotifyConnectionStore.setState({ open: true, authorizeOnOpen: false, failureDetail: '已自动重试 3 次，仍未完成连接。' + failure.detail });
            }
        })();
    }), []);
}
