import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { SpotifyConnection } from '../../../hooks/useSpotifyConnection';
import { getSpotifyConnectionView, SPOTIFY_CONNECTION_STEPS } from '../../../services/onlineMusic/spotifyConnectionSteps';
import { PLAYER_PROGRESS_FRAME_CLASS, playerProgressGlass } from '../../floating-player/playerProgressAppearance';
import SpotifyConnectionSteps, { connectionButtonClass } from './SpotifyConnectionSteps';
import SpotifyDesktopSetup from './SpotifyDesktopSetup';
import { useSpotifyPortalTheme } from './useSpotifyPortalTheme';
import '../../modal/settings/SpotifySetupAppearance.css';

// The first connection saves required setup in one resumable dialog. Playback checks run on track click.
type SpotifyConnectionModalProps = { connection: SpotifyConnection; daylight: boolean; portalTheme?: CSSProperties };

// Keep the presentation separately renderable for SSR; the actual dialog escapes home stacking contexts.
export default function SpotifyConnectionModal(props: SpotifyConnectionModalProps) {
    const { origin, palette } = useSpotifyPortalTheme(props.daylight);
    const dialog = <SpotifyConnectionDialog {...props} portalTheme={palette} />;
    return <><span ref={origin} hidden aria-hidden="true" data-spotify-connection-origin="true" />
        {typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)}</>;
}

export function SpotifyConnectionDialog({ connection, daylight, portalTheme }: SpotifyConnectionModalProps) {
    const { t } = useTranslation();
    const [review, setReview] = useState<number | null>(null);
    const [desktopMode, setDesktopMode] = useState(false);
    const { current, viewed, step, reviewing } = getSpotifyConnectionView(connection.step, review);
    const verified = !connection.checking && connection.error !== 'readFailed';
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, []);
    // Keep the completion owner alive while exposing the provider controller's confirmation underneath.
    return <motion.div initial={{ opacity: 0 }} animate={{ opacity: connection.finishing ? 0 : 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
        inert={connection.finishing} aria-hidden={connection.finishing || undefined}
        ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('home.loginTitleSpotify')} data-folia-keyboard-window="true"
        onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); connection.close(); }
            if (event.key === 'Tab') {
                const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') || []);
                const first = controls[0], last = controls.at(-1);
                if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        }}
        className={`spotify-connection-overlay ${daylight ? 'bg-black/25' : 'bg-black/60'}`} style={{ ...portalTheme, pointerEvents: connection.finishing ? 'none' : undefined }}>
        <motion.div initial={{ scale: 0.96, opacity: 0, y: 16 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className={`spotify-connection-panel relative w-full max-w-lg rounded-3xl ${PLAYER_PROGRESS_FRAME_CLASS} ${playerProgressGlass(daylight, true)}`}
            style={{ color: 'var(--text-primary)', colorScheme: daylight ? 'light' : 'dark' }}>
            <header className="spotify-connection-header">
            <button type="button" aria-label={t('home.closeLogin')} onClick={connection.close} className="spotify-setup-close absolute top-4 right-4 rounded-full p-1"><X size={18} /></button>
            <h3 className="pr-7 text-lg font-medium">{t('home.loginTitleSpotify')}</h3>
            </header>
            <div className="spotify-connection-content" data-testid="spotify-connection-scroll-content">
            <SpotifyDesktopSetup onMode={setDesktopMode} onReady={() => void connection.finishDesktop()} finishing={connection.finishing} />
            {desktopMode && connection.error === 'completeFailed' && <p role="alert" className="text-xs">{t('spotifyConnection.completeFailed')}</p>}
            {!desktopMode && <>
            <ol className="spotify-connection-progress grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" aria-label={t('spotifyConnection.progress')}>
                {SPOTIFY_CONNECTION_STEPS.slice(0, 4).map((item, index) => <li key={item} aria-current={verified && index === viewed ? 'step' : undefined}
                    className={`spotify-connection-step flex items-center gap-2 rounded-xl border p-2 ${index === viewed ? 'spotify-connection-step-current' : ''}`}>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current/20" aria-hidden="true">{verified && index < current ? <Check size={12} /> : index + 1}</span>
                    <span>{t(`spotifyCable.steps.${item}`)}</span>
                </li>)}
            </ol>
            <p className="spotify-connection-intro spotify-setup-hint mb-4 text-xs leading-relaxed">{t('spotifyCable.intro')}</p>
            {connection.checking ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />{t('spotifyConnection.checking')}</p>
                : verified && <SpotifyConnectionSteps connection={connection} step={step} reviewing={reviewing} />}
            {connection.error && <div className="mt-4 space-y-2"><p role="alert" className="text-xs">{t(`spotifyConnection.${connection.error}`)}</p>
                <button type="button" className={connectionButtonClass} disabled={connection.checking || connection.finishing} onClick={() => void connection.inspect()}>{t('spotifyConnection.checkAgain')}</button></div>}
            <p className="spotify-connection-resume spotify-setup-hint mt-3 text-xs leading-relaxed">{t('spotifyConnection.resumeHint')}</p>
            </>}
            </div>
            {!desktopMode && verified && (viewed > 0 || reviewing || step === 'ready') && <footer className="spotify-connection-footer">
            <div className="flex flex-wrap items-center gap-2">
                {verified && viewed > 0 && <button type="button" className={connectionButtonClass} disabled={connection.finishing} onClick={() => setReview(viewed - 1)}>{t('spotifyConnection.back')}</button>}
                {verified && reviewing && <button type="button" className={connectionButtonClass} disabled={connection.finishing} onClick={() => setReview(viewed + 1 >= current ? null : viewed + 1)}>{t('spotifyConnection.continue')}</button>}
                {verified && step === 'ready' && <button type="button" className={connectionButtonClass} disabled={connection.finishing} onClick={() => void connection.finish()}>{t(connection.finishing ? 'spotifyConnection.finishing' : 'spotifyConnection.finish')}</button>}
            </div>
            </footer>}
        </motion.div>
    </motion.div>;
}
