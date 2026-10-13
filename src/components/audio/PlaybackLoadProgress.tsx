import { PLAYER_PROGRESS_FRAME_CLASS, PLAYER_PROGRESS_TEXT_CLASS, PLAYER_PROGRESS_NUMERIC_CLASS,
    playerProgressGlass, playerProgressVariables } from '../floating-player/playerProgressAppearance';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import './playbackLoad.css';
import { useTranslation } from 'react-i18next';
import { usePlaybackLoadStore } from '../../stores/usePlaybackLoadStore';
import { useDecodeCompatibilityStore } from '../../stores/useDecodeCompatibilityStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import PlaybackLoadDetails from './PlaybackLoadDetails';
import { describePlaybackLoad } from './playbackLoadPresentation';

// A quiet, theme-aware preparation indicator with measured bytes and honest indeterminate stages.
export default function PlaybackLoadProgress() {
    const { t } = useTranslation();
    const progress = usePlaybackLoadStore(state => state.progress);
    const startedAt = usePlaybackLoadStore(state => state.startedAt);
    const owner = usePlaybackLoadStore(state => state.owner);
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null), panelRef = useRef<HTMLElement>(null);
    const id = useId();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!progress) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [Boolean(progress)]);
    const prompt = useDecodeCompatibilityStore(state => state.prompt);
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    const close = () => { setOpen(false); trigger.current?.focus(); };
    useEffect(() => { setOpen(false); }, [owner, Boolean(progress), Boolean(prompt)]);
    useEffect(() => {
        if (!open) return;
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
        const outside = (event: PointerEvent) => {
            const node = event.target as Node;
            if (!trigger.current?.contains(node) && !panelRef.current?.contains(node)) setOpen(false);
        };
        window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside);
        return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); };
    }, [open]);
    if (!progress && !prompt) return null;
    const presentation = progress ? describePlaybackLoad(progress, Math.max(0, now - startedAt), t) : null;
    // Stay clickable above the song capsule's invisible hover extension, including narrow windows.
    return <aside data-playback-load className={`fixed ${prompt ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[150] w-72 rounded-2xl p-4' : 'bottom-2 left-6 z-[70] h-5 w-64 rounded-full'} max-w-[calc(100vw-48px)] ${PLAYER_PROGRESS_FRAME_CLASS} ${playerProgressGlass(daylight, Boolean(prompt))}`} style={{ ...playerProgressVariables(daylight), color: 'var(--text-primary)', WebkitAppRegion: 'no-drag' } as CSSProperties}>
        {prompt ? <div role="alertdialog" aria-label={t('loadProgress.compatibility')} aria-describedby="decode-compatibility-description">
            <p id="decode-compatibility-description" className="text-sm mb-3">{t('loadProgress.strictError')}</p>
            <div className="flex flex-wrap gap-2">{(['once', 'always', 'cancel'] as const).map(choice => <button key={choice} className="rounded-lg border border-current/20 px-3 py-2 text-xs hover:bg-current/10" onClick={() => prompt.choose(choice)}>{t(`loadProgress.${choice}`)}</button>)}</div>
        </div> : presentation && <>
            <button ref={trigger} type="button" aria-label={t('loadProgress.details')} aria-expanded={open} aria-controls={id}
                onClick={() => setOpen(value => !value)} className="flex h-full w-full cursor-pointer items-center gap-2 rounded-full px-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-current">
                <span role="status" className={`min-w-0 max-w-28 truncate ${PLAYER_PROGRESS_TEXT_CLASS}`}>{presentation.stage}</span>
                <progress aria-label={presentation.stage} aria-description={`${presentation.completion} · ${presentation.elapsed}`} max={100} value={presentation.percent} className="playback-load-bar min-w-6 flex-1 h-0.5" />
                <span data-playback-load-completion className={`shrink-0 ${PLAYER_PROGRESS_TEXT_CLASS} ${PLAYER_PROGRESS_NUMERIC_CLASS}`}>{presentation.percent === undefined ? presentation.elapsed : `${Math.floor(presentation.percent)}%`}</span>
            </button>
            {createPortal(<AnimatePresence>{open && <PlaybackLoadDetails id={id} panelRef={panelRef} triggerRef={trigger} presentation={presentation} daylight={daylight} onClose={close} />}</AnimatePresence>, document.body)}
        </>}
    </aside>;
}
