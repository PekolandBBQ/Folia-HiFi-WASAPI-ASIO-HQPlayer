import { useTranslation } from 'react-i18next';
import type { ProviderPlaybackSetupStatus } from '../../../types/onlineMusic';

// Retain the historical receipt without offering the retired Spotify volume workflow.
export default function SpotifyColdRecoveryNotice({ status }: { status: ProviderPlaybackSetupStatus }) {
    const { t } = useTranslation();
    const recovery = status.coldRecovery;
    if (!recovery?.archived && !recovery?.required) return null;
    return <section className="spotify-setup-surface space-y-2 rounded-xl border p-3" data-testid="spotify-cold-history">
        <p>{t('spotifyCable.volumeHistoryRetained')}</p>
        {recovery.sourceControlUnconfirmed && <p>{t('spotifyCable.sourceControlUnconfirmed')}</p>}
    </section>;
}
