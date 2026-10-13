import { useTranslation } from 'react-i18next';
import SpotifyColdRecoveryNotice from './SpotifyColdRecoveryNotice';
import type { ProviderPlaybackSetupStatus } from '../../../types/onlineMusic';

// Explain required setup and routing facts while preserving read-only historical recovery facts.
const confirmationLabels = {
    internal44100Confirmed: 'pendingInternalRate', spotifyOnlyConfirmed: 'pendingSpotifyOnly',
} as const;
const codeLabels: Record<string, string> = {
    CABLE_CONFIRMATION_REQUIRED: 'confirmationRequired', CABLE_INTERNAL_RATE_CONFIRMATION_REQUIRED: 'internalConfirmationRequired',
    SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED: 'clientConfirmationRequired', CABLE_IS_DEFAULT_RENDER: 'routeDefault',
    CABLE_SHARED_WITH_OTHER_AUDIO: 'routeShared', FOLIA_FEEDBACK_ROUTE: 'routeFeedback',
    SPOTIFY_ROUTE_NOT_FOUND: 'routeMissing', ROUTE_IDENTITY_UNAVAILABLE: 'routeUnverified',
    ROUTE_OBSERVATION_FAILED: 'routeUnverified', ROUTE_PROBE_FAILED: 'routeProbeFailed',
    FORMAT_LEASE_PROBE_RELEASED: 'probeReleased',
    ROUTE_HELPER_UNAVAILABLE: 'automaticUnavailable', ROUTE_HELPER_UNQUALIFIED: 'automaticUnavailable',
    ROUTE_COMPONENT_INVALID: 'automaticUnavailable', NATIVE_PRODUCT_ADAPTER_UNQUALIFIED: 'automaticUnavailable',
    ROUTE_TRIAL_PLATFORM_MISMATCH: 'automaticTrialPlatform',
    APP_ROUTE_WINDOWS_UNSUPPORTED: 'automaticRuntimePlatform', APP_ROUTE_X64_REQUIRED: 'automaticRuntimePlatform',
    APP_ROUTE_INTERFACE_UNAVAILABLE: 'automaticRuntimeUnavailable', APP_ROUTE_READ_UNAVAILABLE: 'automaticRuntimeUnavailable',
    ROUTE_SOURCE_DEFAULT_REQUIRED: 'sourceDefaultRequired', AUTOMATIC_ROUTE_ON_PLAY: 'automaticOnPlay',
    SOURCE_DEFAULT_POLICY_REQUIRED: 'sourceDefaultRequired', EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN: 'sourceSessionRequired',
    SPOTIFY_AUDIO_PROCESS_AMBIGUOUS: 'routeUnverified',
    ROUTE_SOURCE_PAUSE_UNCONFIRMED: 'automaticRestoreFailed', ROUTE_RESTORE_UNCONFIRMED: 'automaticRestoreFailed',
    ROUTE_HELPER_EXIT_UNCONFIRMED: 'automaticRestoreFailed',
    BOOTSTRAP_VOLUME_UNAVAILABLE: 'bootstrapUnavailable', BOOTSTRAP_VOLUME_UNCONFIRMED: 'bootstrapUnavailable',
    BOOTSTRAP_VOLUME_RECOVERY_REQUIRED: 'bootstrapRecovery', BOOTSTRAP_IDENTITY_UNCONFIRMED: 'bootstrapIdentity',
    PLAYBACK_STATE_UNCONFIRMED: 'sourceControlUnconfirmed', SOURCE_RESTORE_UNCONFIRMED: 'sourceRestoreUnconfirmed',
};
export default function SpotifyCableSetupNotice({ status }: { status: ProviderPlaybackSetupStatus | null }) {
    const { t } = useTranslation();
    const code = status?.code;
    const recoveryRequired = status?.coldRecovery?.required === true;
    const recoveryArchived = status?.coldRecovery?.archived === true;
    if ((!code || code === 'FORMAT_LEASE_ON_PLAY') && !recoveryRequired && !recoveryArchived) return null;
    const missing = ['CABLE_CONFIRMATION_REQUIRED', 'CABLE_INTERNAL_RATE_CONFIRMATION_REQUIRED', 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED'].includes(code || '')
        ? (Object.keys(confirmationLabels) as Array<keyof typeof confirmationLabels>).filter(key => status?.selection?.[key] !== true) : [];
    return <div role="status" className="space-y-1 text-xs leading-relaxed" data-testid="spotify-cable-setup-notice">
        {code && !(recoveryRequired && code === 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED')
            && <p>{t(`spotifyCable.${codeLabels[code] || 'checkFailed'}`)} ({code})</p>}
        {(recoveryRequired || recoveryArchived) && status && <SpotifyColdRecoveryNotice status={status} />}
        {missing.length > 0 && <ul className="list-disc pl-5">{missing.map(key => <li key={key} data-confirmation={key}>
            {t(`spotifyCable.${confirmationLabels[key]}`)}
        </li>)}</ul>}
    </div>;
}
