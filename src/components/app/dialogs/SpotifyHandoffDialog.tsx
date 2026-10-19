import { useState } from 'react';
import ThemedDialog from '../../shared/ThemedDialog';
import { useSpotifyHandoffStore } from '../../../stores/useSpotifyHandoffStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { omni } from '../../../services/onlineMusic/omni';
import { OnlineProviderError } from '../../../types/onlineMusic';

// Shared Folia styling; no native message box and no restriction on closing the app.
export default function SpotifyHandoffDialog() {
    const pending = useSpotifyHandoffStore(state => state.pending);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const [busy, setBusy] = useState(false);
    const choose = async (choice: 'follow' | 'pause' | 'spotify') => {
        if (!pending || busy) return;
        const token = pending.token; setBusy(true);
        try { await omni.resolveExternalSelection('spotify', token, choice); }
        catch (error) {
            const current = useSpotifyHandoffStore.getState().pending;
            const reason = error instanceof OnlineProviderError ? error.details?.userMessage : undefined;
            if (current?.token === token) useSpotifyHandoffStore.setState({pending: {...current, error: reason || '尚未完成播放交接，请稍后再确认。你也可以暂不追随。'}});
        } finally { setBusy(false); }
    };
    return <ThemedDialog isOpen={Boolean(pending)} onClose={() => { if (pending) { useSpotifyHandoffStore.setState({pending: null}); void omni.resolveExternalSelection('spotify', pending.token, 'pause').catch(() => {}); } }} isDaylight={isDaylight}
        title="Spotify 已切换歌曲" description="已暂停 Folia 采集，请选择在哪里继续播放。"
        footer={<div className="flex flex-wrap justify-end gap-2">{([
            ['pause', '暂不追随'], ['spotify', '在 Spotify 中继续'], ['follow', '追随歌曲和进度'],
        ] as const).map(([choice, label]) => <button key={choice} disabled={busy} onClick={() => void choose(choice)}
            className={`rounded-full px-4 py-2 text-sm transition-colors disabled:opacity-50 ${choice === 'follow' ? 'bg-white text-zinc-950 border border-zinc-300' : isDaylight ? 'bg-black/5 hover:bg-black/10' : 'bg-white/10 hover:bg-white/20'}`}>{label}</button>)}</div>}>
        <p className="font-semibold">{pending?.name || 'Spotify 当前歌曲'}</p>
        <p className="mt-2 text-sm opacity-70">追随将从 Spotify 当前进度继续；暂不追随会保持暂停。</p>
        {pending?.error && <p role="alert" className="mt-3 text-sm text-amber-500">{pending.error}</p>}
    </ThemedDialog>;
}
