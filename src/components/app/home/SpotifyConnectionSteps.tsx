import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SpotifyConnection } from '../../../hooks/useSpotifyConnection';
import type { SpotifyConnectionStep } from '../../../services/onlineMusic/spotifyConnectionSteps';
import SpotifyCableFields from '../../modal/settings/SpotifyCableFields';
import SpotifyCableSetupNotice from '../../modal/settings/SpotifyCableSetupNotice';

// First connection reuses the cable settings controller through Omni; reviewing a step never starts playback.
export const connectionButtonClass = 'spotify-setup-button rounded-full border px-4 py-2 text-xs';
export default function SpotifyConnectionSteps({ connection, step, reviewing }: {
    connection: SpotifyConnection; step: SpotifyConnectionStep; reviewing: boolean;
}) {
    const { t } = useTranslation();
    const { setup, login } = connection;
    const authorizing = connection.catalogVerifying || ['loading', 'waiting', 'scanned'].includes(login.qrState);
    return <section className="space-y-4 text-left" data-testid={`spotify-connect-${step}`}>
        <h4 className="text-sm font-medium">{t(`spotifyCable.steps.${step}`)}</h4>
        {step === 'catalog' && <>
            <p className="spotify-setup-hint text-xs leading-relaxed">{t(connection.catalogAuthorized ? 'spotifyConnection.catalogReady' : 'spotifyConnection.catalogHint')}</p>
            {!connection.catalogAuthorized && <>
                {authorizing && <p role="status" className="flex items-center gap-2 text-xs"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />{t('home.spotifyBrowserAuthorization')}</p>}
                {['error', 'expired'].includes(login.qrState) && <p role="alert" className="text-xs">{t('spotifyConnection.authorizationFailed')}</p>}
                <button type="button" className={connectionButtonClass} disabled={authorizing} onClick={() => void login.start('spotify')}>{t('spotifyConnection.authorize')}</button>
            </>}
        </>}
        {(step === 'desktop' || step === 'cable') && <SpotifyCableFields section={step} />}
        {step === 'ready' && <p role="status" className="text-xs leading-relaxed">{t(setup.status?.code === 'FORMAT_LEASE_ON_PLAY' ? 'spotifyCable.idleLease' : 'spotifyCable.ready')}</p>}
        {!reviewing && step !== 'ready' && <SpotifyCableSetupNotice status={setup.status} />}
        {setup.message && !reviewing && <p role={setup.message === 'failed' || setup.message === 'readFailed' ? 'alert' : 'status'} className="text-xs leading-relaxed">{t(`spotifyCable.${setup.message}`)}</p>}
    </section>;
}
