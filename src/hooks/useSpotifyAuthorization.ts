import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createProviderLoginSession } from '../library/core/services/providerLoginSession';
import { omniAccountAuthPort, resolveLoginDiagnosticsEnvironment, windowAccountClock } from '../library/core/services/providerAccountDeps';

// Adapt the upstream login session to Spotify's browser authorization inside its component guide.
export function useSpotifyAuthorization({ onConfirmed }: { onConfirmed: () => Promise<boolean> }) {
    const confirmed = useRef(onConfirmed); confirmed.current = onConfirmed;
    const createSession = () => createProviderLoginSession({ auth: omniAccountAuthPort, clock: windowAccountClock,
        diagnostics: resolveLoginDiagnosticsEnvironment(), onConfirmed: () => confirmed.current() });
    const seed = useRef<ReturnType<typeof createProviderLoginSession> | null>(null);
    const [session, setSession] = useState(() => (seed.current ??= createSession()));
    const disposed = useRef(false);
    useEffect(() => {
        if (disposed.current) { disposed.current = false; setSession(createSession()); return; }
        return () => { session.dispose(); disposed.current = true; };
        // The confirmation callback is read through its current ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const start = useCallback(async (_providerId: 'spotify' = 'spotify') => { await session.start('spotify').settled; }, [session]);
    const stop = useCallback(() => session.stop(), [session]);
    return { qrState: snapshot.phase, start, stop };
}
