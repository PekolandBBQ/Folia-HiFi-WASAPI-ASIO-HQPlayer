import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSpotifyPlaybackSetup } from '../../../hooks/useSpotifyPlaybackSetup';
import SpotifyCableFields from './SpotifyCableFields';
import SpotifyCableSetupNotice from './SpotifyCableSetupNotice';
import SpotifyPlaybackProgress from './SpotifyPlaybackProgress';

// Setup remains behind Omni and displays observed cable readiness independently of catalog authorization.
export default function SpotifyPlaybackSetup() {
    const { t } = useTranslation();
    const { status, busy, message, progress } = useSpotifyPlaybackSetup(state => state);
    return <div className="space-y-3 border-t border-current/10 pt-4" data-testid="spotify-playback-setup">
        <h4 className="text-sm font-medium">{t('spotifyCable.title')}</h4>
        <p className="text-xs opacity-65 leading-relaxed">{t('spotifyCable.description')}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
            {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
            <span>{status ? t(status.code === 'AUTOMATIC_ROUTE_ON_PLAY' ? 'spotifyCable.setupSaved' : `spotifyCable.states.${status.state}`) : t('spotifyPlayback.reading')}</span>
        </div>
        <SpotifyCableFields />
        <SpotifyCableSetupNotice status={status} />
        <SpotifyPlaybackProgress progress={progress} />
        {message && <p role="status" className="text-xs leading-relaxed">{t(`spotifyCable.${message}`)}</p>}
    </div>;
}
