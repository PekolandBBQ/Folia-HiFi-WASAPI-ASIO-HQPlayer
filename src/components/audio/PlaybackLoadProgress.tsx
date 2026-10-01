import { audioGlass } from './audioGlass';
import { useEffect, useState } from 'react';
import './playbackLoad.css';
import { useTranslation } from 'react-i18next';
import { usePlaybackLoadStore } from '../../stores/usePlaybackLoadStore';
import { useDecodeCompatibilityStore } from '../../stores/useDecodeCompatibilityStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';

// A quiet, theme-aware preparation indicator with measured bytes and honest indeterminate stages.
export default function PlaybackLoadProgress() {
    const { t } = useTranslation();
    const progress = usePlaybackLoadStore(state => state.progress);
    const startedAt = usePlaybackLoadStore(state => state.startedAt);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!progress) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [Boolean(progress)]);
    const prompt = useDecodeCompatibilityStore(state => state.prompt);
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    if (!progress && !prompt) return null;
    const percent = progress?.total && progress.total > 0 ? Math.min(100, (progress.loaded || 0) / progress.total * 100) : undefined;
    const details = `${progress?.loaded !== undefined ? `${(progress.loaded / 1048576).toFixed(1)} MB · ` : ''}${(Math.max(progress?.elapsedMs || 0, now - startedAt, 0) / 1000).toFixed(0)} s`;
    return <aside data-playback-load className={`fixed ${prompt ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[150] w-72 rounded-2xl p-4' : 'bottom-2 left-6 z-40 h-5 w-64 rounded-full px-2 flex items-center gap-2 pointer-events-none'} max-w-[calc(100vw-48px)] border shadow-sm backdrop-blur-xl ${audioGlass(daylight)}`} style={{ color: 'var(--text-primary)' }}>
        {prompt ? <div role="alertdialog" aria-label={t('loadProgress.compatibility')} aria-describedby="decode-compatibility-description">
            <p id="decode-compatibility-description" className="text-sm mb-3">{t('loadProgress.strictError')}</p>
            <div className="flex flex-wrap gap-2">{(['once', 'always', 'cancel'] as const).map(choice => <button key={choice} className="rounded-lg border border-current/20 px-3 py-2 text-xs hover:bg-current/10" onClick={() => prompt.choose(choice)}>{t(`loadProgress.${choice}`)}</button>)}</div>
        </div> : progress && <>
            <span role="status" className="min-w-0 max-w-28 truncate text-[10px] leading-none">{t(`loadProgress.${progress.stage}`)}</span>
            <progress aria-label={t(`loadProgress.${progress.stage}`)} aria-description={details} max={100} value={percent} className="playback-load-bar min-w-6 flex-1 h-0.5" />
            <span className="shrink-0 text-[10px] leading-none opacity-70 tabular-nums">{percent === undefined ? details : `${Math.floor(percent)}%`}</span>
        </>}
    </aside>;
}
