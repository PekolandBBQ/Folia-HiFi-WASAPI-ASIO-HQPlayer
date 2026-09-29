import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { manageHQPlayerComponent, type HQPlayerStatus } from '../../services/nativeAudio/hqplayerSettings';
import { nativeErrorKey } from '../../services/nativeAudio/errors';

// This component's version and lifecycle are independent of both Desktop and the WASAPI/ASIO helper.
export default function HQPlayerComponentSetting({ status, active, onChange }: {
    status: HQPlayerStatus; active: boolean; onChange: (status: HQPlayerStatus) => void;
}) {
    const { t } = useTranslation(); const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const component = status.component;
    if (!component) return null;
    const manage = async (action: 'install' | 'uninstall' | 'rollback') => {
        setBusy(true); setError('');
        try { onChange(await manageHQPlayerComponent(action)); } catch (failure) { setError(t(nativeErrorKey(failure))); }
        finally { setBusy(false); }
    };
    return <div className="my-4 border-y border-current/10 py-3" data-testid="hqplayer-component">
        <p className="text-sm font-medium">{t('hqpComponent.title')} · {component.version || t('hqpComponent.missing')}</p>
        <p className="mt-2 text-xs opacity-70">{t('hqpComponent.description')}</p>
        <p className="mt-2 text-xs">{t(component.available ? component.updateAvailable ? 'hqpComponent.updateAvailable' : 'hqpComponent.ready' : 'hqpComponent.disabled')}</p>
        {active && <p className="mt-2 text-xs opacity-70">{t('hqpComponent.switchFirst')}</p>}
        {!component.installable && <p className="mt-2 text-xs opacity-70">{t('hqpComponent.noRelease')}</p>}
        <div className="mt-3 flex flex-wrap gap-2">{(['install', 'uninstall', 'rollback'] as const).map(action => <button key={action} type="button"
            disabled={active || busy || component.busy || (action === 'install' ? !component.installable : action === 'uninstall' ? !component.available : !component.rollbackAvailable)}
            className="rounded-lg border px-3 py-2 text-xs disabled:opacity-40" onClick={() => void manage(action)}>{t(`hqpComponent.${action}`)}</button>)}</div>
        {error && <p role="alert" className="mt-2 text-xs">{error}</p>}
    </div>;
}
