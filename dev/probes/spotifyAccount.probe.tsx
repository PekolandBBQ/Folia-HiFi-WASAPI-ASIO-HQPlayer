import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { useSpotifyLibrary } from '../../src/hooks/useSpotifyLibrary';
import { useLibraryAccountController } from '../../src/library/app/useLibraryAccountController';
import { useLibraryAccountProviders } from '../../src/library/core/bindings/useLibraryAccount';
import { useSpotifyConnection } from '../../src/hooks/useSpotifyConnection';
import SpotifyConnectionModal from '../../src/components/app/home/SpotifyConnectionModal';
import { useThemeSettingsStore } from '../../src/stores/useThemeSettingsStore';
import type { CSSProperties } from 'react';
import type { ProbeDefinition } from './definition';

// The actual Spotify adapter, setup controller and connection guide run under StrictMode.
function SpotifyAccountProbe() {
    const { t } = useTranslation();
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    const library = useSpotifyLibrary();
    const refreshers = useMemo(() => ({ spotify: library.refresh }), [library.refresh]);
    const logouts = useMemo(() => ({ spotify: library.logout }), [library.logout]);
    const controller = useLibraryAccountController({ refreshers, logouts, switchCleanup: { resetForProviderSwitch: async () => {} } });
    const { providers } = useLibraryAccountProviders(controller);
    const connection = useSpotifyConnection(isCurrent => controller.completeExternalLogin!('spotify', isCurrent));
    const account = providers.find(provider => provider.providerId === 'spotify');
    return <div className="p-8 min-h-screen" style={{ color: 'var(--text-primary)', background: daylight ? '#dce4e8' : '#24323b',
        '--text-primary': daylight ? '#1d252b' : '#f2f3f4', '--text-secondary': daylight ? '#3c454c' : '#d6dbdf' } as CSSProperties}>
        <output data-testid="account-state">{account?.status}</output>
        <button onClick={connection.begin}>{t('home.loginTitleSpotify')}</button>
        <button onClick={() => void controller.logout('spotify')}>Disconnect</button>
        <ul>{account?.collections.map(item => <li key={item.id}>{item.name}</li>)}</ul>
        <AnimatePresence>{connection.open && <SpotifyConnectionModal connection={connection} daylight={daylight} />}</AnimatePresence>
    </div>;
}
export default { id: 'spotifyAccount', title: 'Spotify account preview', description: 'Shared QR login and library lifecycle.', Component: SpotifyAccountProbe } satisfies ProbeDefinition;
