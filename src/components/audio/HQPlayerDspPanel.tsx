import { useEffect, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import HQPlayerDspEditor from './HQPlayerDspEditor';

// Floating disclosure shares the settings editor, including its portaled dropdown menus.
export default function HQPlayerDspPanel({ panelClass, buttonClass, onOpenChange }: {
    panelClass: string; buttonClass: string; onOpenChange?: (open: boolean) => void;
}) {
    const { t } = useTranslation();
    const open = useHQPlayerSettingsStore(state => state.dspOpen);
    const setOpen = useHQPlayerSettingsStore(state => state.setDspOpen);
    const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);
    useEffect(() => {
        if (!open) return;
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
        const outside = (event: PointerEvent) => {
            if (!container.current?.contains(event.target as Node) && !(event.target as Element)?.closest('[role="listbox"]')) setOpen(false);
        };
        window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside);
        return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); };
    }, [open, setOpen]);
    return <div ref={container}>
        <button ref={trigger} aria-label={t('hqpDsp.button')} aria-expanded={open} onClick={() => setOpen(!open)} className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium shadow-lg backdrop-blur-xl ${buttonClass}`}><SlidersHorizontal size={14} /><span>{t('hqpDsp.button')}</span></button>
        {open && <section role="region" aria-label={t('hqpDsp.title')} className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-80 max-w-[calc(100vw-24px)] max-h-[calc(100dvh-180px)] overflow-y-auto rounded-2xl border p-4 shadow-2xl backdrop-blur-2xl ${panelClass}`}>
            <div className="flex items-center justify-between mb-3"><h2 className="text-sm font-semibold">{t('hqpDsp.title')}</h2><button aria-label={t('signalPath.close')} onClick={() => setOpen(false)}><X size={16} /></button></div>
            <div className="mb-3 text-xs opacity-70"><p>{t('hqpDsp.input')}</p><p className="mt-1">{t('hqpDsp.devices')}</p></div>
            <HQPlayerDspEditor />
        </section>}
    </div>;
}
