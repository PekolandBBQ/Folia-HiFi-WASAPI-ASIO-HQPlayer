import { useEffect, useRef, useState } from 'react';

// Observe fork releases without downloading; each build prompts once per app session.
export function useForkUpdatePrompt() {
    const [status, setStatus] = useState<ElectronUpdateStatus | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const seen = useRef(new Set<string>());
    useEffect(() => {
        const api = window.electron;
        if (!api) return;
        let active = true, eventReceived = false;
        const accept = (value: ElectronUpdateStatus) => {
            if (!active) return;
            setStatus(value);
            if (!value.forkUpdate || !value.availableVersion || !['available', 'downloaded'].includes(value.status)) return;
            const key = `${value.availableVersion}#${value.availableBuild || ''}`;
            if (!seen.current.has(key)) { seen.current.add(key); setOpen(true); }
        };
        const unsubscribe = api.onUpdateStatusChanged?.(value => { eventReceived = true; accept(value); });
        void api.getUpdateStatus?.().then(value => { if (!eventReceived) accept(value); }).catch(() => {});
        return () => { active = false; unsubscribe?.(); };
    }, []);
    const download = async () => {
        if (busy) return;
        setBusy(true); setError('');
        try { const value = await window.electron?.downloadUpdate(); if (value) setStatus(value); }
        catch { setError('下载未完成，请稍后重试。'); }
        finally { setBusy(false); }
    };
    const install = async () => {
        if (busy) return;
        setBusy(true); setError('');
        try { await window.electron?.quitAndInstallUpdate(); }
        catch { setError('未能启动更新，请稍后重试。'); }
        finally { setBusy(false); }
    };
    return { status, open, busy, error, close: () => setOpen(false), download, install };
}
