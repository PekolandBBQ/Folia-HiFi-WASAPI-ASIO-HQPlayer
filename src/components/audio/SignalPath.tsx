import HQPlayerDspPanel from './HQPlayerDspPanel';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { isStagePlaybackSong } from '../../utils/appPlaybackGuards';
import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useSignalPathStore } from '../../stores/useSignalPathStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { buildSignalPath } from './buildSignalPath';
import './signalPath.css';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useSignalPathTransition } from './useSignalPathTransition';

// A compact signal-path disclosure based on observed telemetry, not requested quality settings.
export default function SignalPath({ anchored = false, onOpenChange }: { anchored?: boolean; onOpenChange?: (open: boolean) => void }) {
    const { t } = useTranslation();
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const glassPanel = isDaylight ? 'bg-white/85 border-white/30' : 'bg-black/75 border-white/10';
    const glassButton = isDaylight ? 'bg-white/40 border-white/20 hover:bg-white/50' : 'bg-black/20 border-white/5 hover:bg-black/30';
    const song = usePlaybackStore(state => state.currentSong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const snapshot = useSignalPathStore(state => state.snapshot);
    const selected = useAudioSettingsStore(state => state.nativeAudioBackend);
    const enabled = useAudioSettingsStore(state => state.showAudioSignalPath);
    const dspOpen = useHQPlayerSettingsStore(state => state.dspOpen);
    const [open, setOpen] = useState(false);
    const compact = useMediaQuery('(max-height: 760px)');
    const wide = useMediaQuery('(min-width: 600px)');
    const columns = compact && wide;
    const panelRef = useSignalPathTransition(open, compact + ':' + columns);
    useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => { setOpen(false); }, [audioSrc]);
    useEffect(() => {
        if (!open) return;
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside);
        return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); };
    }, [open]);
    const hasSource = Boolean(song && !isStagePlaybackSong(song) && audioSrc);
    if ((!enabled && selected !== 'hqplayer') || selected === 'browser'
        || (song && isStagePlaybackSong(song)) || (!hasSource && selected !== 'hqplayer')) return null;
    const { rows, brief } = buildSignalPath(snapshot, selected, t);
    return <div ref={container} data-signal-path onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} className={`${anchored ? 'absolute bottom-full mb-2' : 'fixed bottom-1'} left-1/2 -translate-x-1/2 z-[90] w-max max-w-[calc(100vw-24px)] pointer-events-auto flex items-center gap-2`} style={{ WebkitAppRegion: 'no-drag', color: 'var(--text-primary)' } as React.CSSProperties}>
        {open && !dspOpen && <section ref={panelRef} data-compact={compact} data-columns={columns} id="folia-signal-path" role="region" aria-label={t('signalPath.title')} className={`signal-path-panel absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-80 max-w-[calc(100vw-24px)]  overflow-auto rounded-2xl border ${glassPanel} p-5 shadow-2xl backdrop-blur-2xl`}>
            <div className="flex items-center justify-between mb-4"><h2 className="text-sm font-semibold">{t('signalPath.title')}</h2><button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }} aria-label={t('signalPath.close')} className="p-2 rounded-full hover:bg-white/10"><X size={16} /></button></div>
            <ol className="signal-path-rows">{rows.map((row, index) => <li key={row.title} className="relative pl-6 pb-5 last:pb-0">
                {index < rows.length - 1 && <span className="absolute left-[5px] top-3 bottom-0 w-px bg-current opacity-15" />}
                <span className={`absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full bg-current opacity-70`} />
                <div className="text-[11px] opacity-60 mb-1">{row.title}</div><div className="text-sm break-words">{row.value}</div>
            </li>)}</ol>
            <p className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed opacity-60">{t('signalPath.caveat')}</p>
        </section>}
        {enabled && <button ref={trigger} type="button" aria-expanded={open} aria-controls="folia-signal-path" onClick={() => setOpen(value => !value)} className={`flex max-w-full items-center justify-center gap-2 rounded-full border ${glassButton} px-4 py-2 text-xs font-medium shadow-lg backdrop-blur-xl transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current`}>
            <AudioLines size={14} className="shrink-0 opacity-60" />
            <span className="opacity-80">{brief}</span>
        </button>}
        {selected === 'hqplayer' && <HQPlayerDspPanel panelClass={glassPanel} buttonClass={glassButton} onOpenChange={onOpenChange} />}
    </div>;
}
