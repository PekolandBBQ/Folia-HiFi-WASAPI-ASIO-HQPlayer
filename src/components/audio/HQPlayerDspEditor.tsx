import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HQPlayerDspCatalog, HQPlayerDspSettings } from '../../types/hqplayerDsp';
import { useSignalPathStore } from '../../stores/useSignalPathStore';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { nativeErrorKey } from '../../services/nativeAudio/errors';
import HQPlayerDspFields from './HQPlayerDspFields';

// Persisted defaults and one-song overrides have separate save actions.
export default function HQPlayerDspEditor({ defaults = false }: { defaults?: boolean }) {
    const { t } = useTranslation();
    const [data, setData] = useState<HQPlayerDspCatalog | null>(null);
    const [draft, setDraft] = useState<HQPlayerDspSettings | null>(null);
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const snapshot = useSignalPathStore(state => state.snapshot);
    const saved = useHQPlayerSettingsStore(state => state.dspDefaults), save = useHQPlayerSettingsStore(state => state.setDspDefaults);
    const generation = useRef(0), authorization = useRef<AbortController | null>(null);
    const reload = async () => {
        const ticket = ++generation.current;
        authorization.current?.abort();
        const controller = new AbortController(); authorization.current = controller;
        setBusy(true); setMessage('');
        try {
            const { authorizeHQPlayerConnection } = await import('../../services/nativeAudio/hqplayerSettings');
            if (!await authorizeHQPlayerConnection(controller.signal) || controller.signal.aborted) return;
            const result = await window.electron!.nativeAudio!.request({ action: 'hqplayer-dsp-read' }) as HQPlayerDspCatalog;
            if (ticket !== generation.current) return;
            setData(result);
            const current = result.catalogs[result.state.mode];
            setDraft((defaults ? saved : result.pending) || { mode: result.state.mode,
                filter: current?.filters.find(item => item.index === result.state.filter)?.name || '',
                shaper: current?.shapers.find(item => item.index === result.state.shaper)?.name || '',
                rate: current?.rates.find(item => item.index === result.state.rate)?.rate ?? 0 });
        } catch (error) { if (ticket === generation.current) setMessage(t(nativeErrorKey(error))); }
        finally { if (ticket === generation.current) setBusy(false); }
    };
    useEffect(() => {
        // Merely visiting settings must not launch HQPlayer and acquire a DAC.
        if (!defaults) void reload();
        return () => { ++generation.current; authorization.current?.abort(); };
    }, [defaults]);
    const catalog = draft && data?.catalogs[draft.mode];
    const valid = catalog && draft && catalog.filters.some(item => item.name === draft.filter)
        && catalog.shapers.some(item => item.name === draft.shaper) && catalog.rates.some(item => item.rate === draft.rate);
    const apply = async (when: 'current' | 'next') => {
        if (!draft) return;
        setBusy(true); setMessage('');
        try {
            await window.electron!.nativeAudio!.request({ action: 'hqplayer-dsp-apply', settings: draft, when, session: snapshot?.session });
            setMessage(t(when === 'current' ? 'hqpDsp.applied' : 'hqpDsp.queued'));
        } catch (error) { setMessage(t(nativeErrorKey(error))); }
        finally { setBusy(false); }
    };
    const button = 'rounded-lg border border-current/20 p-2 text-xs disabled:opacity-40';
    return <div>
        {defaults && <p className="my-3 text-xs opacity-70">{t('hqpDsp.defaultsDescription')}</p>}
        {defaults && saved && !data && <p className="text-xs break-words">{saved.filter} · {saved.shaper}</p>}
        {draft && data && <HQPlayerDspFields data={data} draft={draft} setDraft={setDraft} disabled={busy} />}
        <div className="mt-3 flex flex-wrap gap-2">{defaults ? <>
            <button disabled={busy || !valid} className={button} onClick={() => { save(draft); setMessage(t('hqpDsp.defaultsSaved')); }}>{t('hqpDsp.saveDefaults')}</button>
            <button disabled={busy || !saved} className={button} onClick={() => { save(null); setMessage(t('hqpDsp.defaultsCleared')); }}>{t('hqpDsp.clearDefaults')}</button>
        </> : <>
            <button disabled={busy || !valid || snapshot?.backend !== 'hqplayer'} className={button} onClick={() => void apply('current')}>{t('hqpDsp.current')}</button>
            <button disabled={busy || !valid} className={button} onClick={() => void apply('next')}>{t('hqpDsp.next')}</button>
        </>}</div>
        <p role="status" className="mt-3 text-xs">{busy ? t('hqpDsp.loading') : message}</p>
        <button disabled={busy} onClick={() => void reload()} className="mt-2 text-xs underline">{t('hqpDsp.refresh')}</button>
    </div>;
}
