import { useEffect } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { registerSourceLoopController, useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';

// Spotify owns its repeat setting. Other providers retain their saved Folia queue preference.
export function useSpotifyRepeatMode() {
    const provider = useOnlineProviderAccountStore(state => state.activeProviderId);
    useEffect(() => {
        if (provider !== 'spotify') return;
        const previous = useAudioSettingsStore.getState().loopMode;
        let disposed = false, reading = false, writing = false, epoch = 0;
        const read = async () => {
            if (disposed || reading || writing) return;
            reading = true; const revision = epoch;
            try {
                const mode = await omni.providerRepeatMode('spotify');
                if (!disposed && revision === epoch) useAudioSettingsStore.setState({ loopMode: mode });
            } catch { /* Background startup/reconnect owns recovery; browsing is not an error. */ }
            finally { reading = false; }
        };
        const unbind = registerSourceLoopController(() => {
            if (writing) return;
            writing = true; ++epoch;
            void (async () => {
                try {
                    // Refresh first: Spotify's own button may have changed since our last poll.
                    const actual = await omni.providerRepeatMode('spotify');
                    if (disposed) return;
                    const next = actual === 'off' ? 'all' : actual === 'all' ? 'one' : 'off';
                    const confirmed = await omni.providerRepeatMode('spotify', next);
                    if (disposed) return;
                    useAudioSettingsStore.setState({ loopMode: confirmed });
                    setStatusMessage({ type: 'success', text: confirmed === 'off' ? '已关闭循环' : confirmed === 'all' ? '已开启列表循环' : '已开启单曲循环' });
                } catch {
                    if (!disposed) setStatusMessage({ type: 'error', text: 'Spotify 尚未确认循环模式，请等待连接恢复后再切换。当前循环模式未更改。' });
                } finally { writing = false; void read(); }
            })();
        });
        void read(); const timer = setInterval(() => void read(), 2000);
        return () => { disposed = true; ++epoch; clearInterval(timer); unbind(); useAudioSettingsStore.setState({ loopMode: previous }); };
    }, [provider]);
}
