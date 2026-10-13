import { useTranslation } from 'react-i18next';
import type { SpotifyPlaybackSetupState } from '../../../services/onlineMusic/spotifyPlaybackSetup';

// The settings screen and first-connection guide display the same measured
// download progress. Unknown totals intentionally have no percentage.
export default function SpotifyPlaybackProgress({ progress }: Pick<SpotifyPlaybackSetupState, 'progress'>) {
    const { t } = useTranslation();
    if (!progress) return null;
    const percent = progress.total && progress.loaded != null ? Math.min(100, Math.max(0, progress.loaded / progress.total * 100)) : null;
    return <div className="space-y-1 text-xs opacity-75" aria-live="polite">
        <p>{t(`loadProgress.${progress.stage}`)}{percent != null ? ` · ${Math.round(percent)}%` : ''}</p>
        {percent != null && <div role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}
            className="h-1 overflow-hidden rounded-full bg-current/10"><div className="h-full rounded-full bg-current/50 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>}
    </div>;
}
