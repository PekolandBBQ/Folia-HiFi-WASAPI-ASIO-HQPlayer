import { AnimatePresence } from 'framer-motion';
import type { LibraryAccountController } from '../../../library/core/contracts/account';
import { useSpotifyConnection } from '../../../hooks/useSpotifyConnection';
import SpotifyConnectionModal from './SpotifyConnectionModal';

// Keep the Spotify component guide independent of the active library suite and its QR renderer.
export default function SpotifyConnectionHost({ account, daylight }: { account: LibraryAccountController; daylight: boolean }) {
    const connection = useSpotifyConnection(isCurrent => account.completeExternalLogin?.('spotify', isCurrent) ?? Promise.resolve(false));
    return <AnimatePresence>{connection.open && <SpotifyConnectionModal connection={connection} daylight={daylight} />}</AnimatePresence>;
}
