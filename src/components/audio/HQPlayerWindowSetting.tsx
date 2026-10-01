import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSwitch from '../shared/SettingsSwitch';
import { useHQPlayerWindowStore, refreshHQPlayerWindow } from '../../stores/useHQPlayerWindowStore';
import { useSignalPathStore } from '../../stores/useSignalPathStore';

// An immediate show/hide action, separate from the preference for the next Desktop launch.
export default function HQPlayerWindowSetting() {
    const { t } = useTranslation();
    const { running, visible, controllable, busy } = useHQPlayerWindowStore();
    const session = useSignalPathStore(state => state.snapshot?.session);
    useEffect(() => {
        const refresh = () => { void refreshHQPlayerWindow(); };
        refresh(); window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [session]);
    return <label className="my-3 flex items-center justify-between gap-3 text-xs">
        <span>{t('hqpLaunch.showWindow')}<span className="mt-1 block opacity-60">{t(running ? 'hqpLaunch.showWindowDescription' : 'hqpLaunch.windowNotRunning')}</span></span>
        <SettingsSwitch label={t('hqpLaunch.showWindow')} checked={visible} disabled={busy || !controllable} onChange={value => void refreshHQPlayerWindow(value)} />
    </label>;
}
