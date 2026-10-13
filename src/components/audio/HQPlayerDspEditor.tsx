import { getHQPlayerDspCache, readHQPlayerDsp, dspDraft, invalidateHQPlayerDsp, setHQPlayerDspSession } from '../../services/nativeAudio/hqplayerDspCache';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HQPlayerDspCatalog, HQPlayerDspSettings } from '../../types/hqplayerDsp';
import { useSignalPathStore } from '../../stores/useSignalPathStore';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { nativeErrorKey } from '../../services/nativeAudio/errors';
import HQPlayerDspFields from './HQPlayerDspFields';
import HQPlayerDspSkeleton from './HQPlayerDspSkeleton';

// Persisted defaults and one-song overrides have separate save actions.
export default function HQPlayerDspEditor({ defaults = false }: { defaults?: boolean }) {
    const { t } = useTranslation();
    const snapshot = useSignalPathStore(state => state.snapshot);
    const session = snapshot?.backend === 'hqplayer' ? snapshot.session : '';
    const [data, setData] = useState<HQPlayerDspCatalog | null>(() => getHQPlayerDspCache(session));
    const [draft, setDraft] = useState<HQPlayerDspSettings | null>(() => { const cached = getHQPlayerDspCache(session); return (defaults ? useHQPlayerSettingsStore.getState().dspDefaults : null) || (cached ? dspDraft(cached) : null); });
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const saved = useHQPlayerSettingsStore(state => state.dspDefaults), save = useHQPlayerSettingsStore(state => state.setDspDefaults);
    const edited = useRef(false);
    const generation = useRef(0), authorization = useRef<AbortController | null>(null);
    const reload = async () => {
        const ticket = ++generation.current;
        authorization.current?.abort();
        const controller = new AbortController(); authorization.current = controller;
        setBusy(true); setMessage('');
        try {
            const { authorizeHQPlayerConnection } = await import('../../services/nativeAudio/hqplayerSettings');
            if (!await authorizeHQPlayerConnection(controller.signal) || controller.signal.aborted || ticket !== generation.current) return;
            const result = await readHQPlayerDsp();
            if (ticket !== generation.current) return;
            setData(result);
            setDraft((defaults ? saved : null) || dspDraft(result));
        } catch (error) { if (ticket === generation.current) setMessage(t(nativeErrorKey(error))); }
        finally { if (ticket === generation.current) setBusy(false); }
    };
    useEffect(() => {
        setHQPlayerDspSession(session);
        const cached = getHQPlayerDspCache(session);
        edited.current = false;
        setData(cached); setDraft((defaults ? saved : null) || (cached ? dspDraft(cached) : null));
        setMessage(''); setBusy(false);
        // Merely visiting settings must not launch HQPlayer and acquire a DAC.
        if (!defaults) {
            if (!cached) void reload();
            else {
                const ticket = generation.current;
                // Keep complete cached fields visible while refreshing externally changed settings.
                void readHQPlayerDsp().then(result => {
                    if (generation.current !== ticket || edited.current) return;
                    setData(result); setDraft(dspDraft(result));
                }).catch(() => {});
            }
        }
        return () => { ++generation.current; authorization.current?.abort(); };
    }, [defaults, session]);
    const catalog = draft && data?.catalogs[draft.mode];
    const valid = catalog && draft && catalog.filters.some(item => item.name === draft.filter)
        && catalog.shapers.some(item => item.name === draft.shaper) && catalog.rates.some(item => item.rate === draft.rate);
    const apply = async (when: 'current' | 'next') => {
        if (!draft) return;
        const ticket = ++generation.current;
        setBusy(true); setMessage('');
        try {
            await window.electron!.nativeAudio!.request({ action: 'hqplayer-dsp-apply', settings: draft, when, session: snapshot?.session });
            if (ticket !== generation.current) return;
            invalidateHQPlayerDsp();
            void readHQPlayerDsp().catch(() => {});
            setMessage(t(when === 'current' ? 'hqpDsp.applied' : 'hqpDsp.queued'));
        } catch (error) { if (ticket === generation.current) setMessage(t(nativeErrorKey(error))); }
        finally { if (ticket === generation.current) setBusy(false); }
    };
    const button = 'rounded-lg border border-current/20 p-2 text-xs disabled:opacity-40';
    const loadingFields = !data && (busy || (!defaults && !message));
    return <div data-hqplayer-dsp-ready={Boolean(data && draft)} aria-busy={busy || loadingFields}>
        {defaults && <p className="my-3 text-xs opacity-70">{t('hqpDsp.defaultsDescription')}</p>}
        {defaults && saved && !data && <p className="text-xs break-words">{saved.filter} · {saved.shaper}</p>}
        {loadingFields && <HQPlayerDspSkeleton />}
        {draft && data && <HQPlayerDspFields data={data} draft={draft} setDraft={value => { edited.current = true; setDraft(value); }} disabled={busy} />}
        {!loadingFields && (defaults || (draft && data)) && <div className="mt-3 flex flex-wrap gap-2">{defaults ? <>
            <button disabled={busy || !valid} className={button} onClick={() => { save(draft); setMessage(t('hqpDsp.defaultsSaved')); }}>{t('hqpDsp.saveDefaults')}</button>
            <button disabled={busy || !saved} className={button} onClick={() => { save(null); setMessage(t('hqpDsp.defaultsCleared')); }}>{t('hqpDsp.clearDefaults')}</button>
        </> : <>
            <button disabled={busy || !valid || snapshot?.backend !== 'hqplayer'} className={button} onClick={() => void apply('current')}>{t('hqpDsp.current')}</button>
            <button disabled={busy || !valid} className={button} onClick={() => void apply('next')}>{t('hqpDsp.next')}</button>
        </>}</div>}
        <p role="status" className="mt-3 text-xs">{busy || loadingFields ? t('hqpDsp.loading') : message}</p>
        <button disabled={busy} onClick={() => void reload()} className="mt-2 text-xs underline">{t('hqpDsp.refresh')}</button>
    </div>;
}
