import { motion, type MotionStyle } from 'framer-motion';
import { useLayoutEffect, useState, type RefObject } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';
import { usePlayerBottomBarBottomPx } from '../../hooks/usePlayerBottomBarBottomPx';
import { PLAYER_PROGRESS_FRAME_CLASS, playerProgressGlass } from '../floating-player/playerProgressAppearance';
import type { describePlaybackLoad } from './playbackLoadPresentation';

// Keep the explicit loading disclosure above the song toast and standalone audio controls, using the same bottom baseline.
export default function PlaybackLoadDetails({ id, panelRef, triggerRef, presentation, daylight, onClose }: {
    id: string; panelRef: RefObject<HTMLElement | null>; presentation: ReturnType<typeof describePlaybackLoad>;
    triggerRef: RefObject<HTMLButtonElement | null>;
    daylight: boolean; onClose: () => void;
}) {
    const { t } = useTranslation();
    const reduced = useReducedMotionFor('uiMicroMotion');
    const bottom = usePlayerBottomBarBottomPx(144);
    const readAppearance = () => {
        const style = getComputedStyle(triggerRef.current?.closest('[data-playback-load]') || document.body);
        return { color: style.color, fontFamily: style.fontFamily,
            '--folium-progress-fill': style.getPropertyValue('--folium-progress-fill'),
            '--folium-progress-track': style.getPropertyValue('--folium-progress-track'),
            '--folium-progress-text': style.getPropertyValue('--folium-progress-text') };
    };
    const [appearance, setAppearance] = useState(readAppearance);
    useLayoutEffect(() => {
        const next = readAppearance();
        setAppearance(old => Object.entries(next).every(([key, value]) => old[key as keyof typeof old] === value) ? old : next);
    }, [daylight]);
    return <motion.section ref={panelRef} id={id} role="region" aria-label={t('loadProgress.details')}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
        transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
        className={`fixed left-6 z-[140] w-72 max-w-[calc(100vw-48px)] max-h-[calc(100dvh-168px)] overflow-auto rounded-2xl p-4 ${PLAYER_PROGRESS_FRAME_CLASS} ${playerProgressGlass(daylight, true)}`}
        style={{ bottom, ...appearance, WebkitAppRegion: 'no-drag' } as MotionStyle}>
        <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t('loadProgress.details')}</h2>
            <button type="button" aria-label={t('loadProgress.closeDetails')} onClick={onClose} className="rounded-full p-1 hover:bg-current/10"><X size={16} /></button>
        </div>
        <dl className="space-y-2 text-xs">
            {([
                ['stage', presentation.stage], ['completion', presentation.completion], ['elapsed', presentation.elapsed],
            ] as const).map(([key, value]) => <div key={key} className="flex items-start justify-between gap-3">
                <dt className="shrink-0 opacity-60 text-[var(--folium-progress-text)]">{t(`loadProgress.${key}`)}</dt><dd className="text-right tabular-nums">{value}</dd>
            </div>)}
        </dl>
        <p className="mt-3 border-t border-current/10 pt-3 text-xs leading-relaxed opacity-70">{presentation.reason}</p>
    </motion.section>;
}
