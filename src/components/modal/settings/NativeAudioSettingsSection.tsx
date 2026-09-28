import { nativeErrorKey } from '../../../services/nativeAudio/errors';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, RefreshCw } from 'lucide-react';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { useTranslation } from 'react-i18next';
import { CustomSelect } from '../../shared/CustomSelect';
import ThemedDialog from '../../shared/ThemedDialog';
import { readNativeComponentStatus, withNativeAudioComponent, type NativeComponentStatus } from '../../../services/nativeAudio/settingsGate';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { setPlayerState } from '../../../stores/usePlaybackStore';
import { isNativeAudioSupported } from '../../../services/nativeAudio/capabilities';
import { PlayerState, type Theme } from '../../../types';
import type { NativeAudioBackend, NativeAudioDevice } from '../../../types/nativeAudio';
import { settingsToggleOffClassFor } from './settingsCardClasses';

// src/components/modal/settings/NativeAudioSettingsSection.tsx — native backend and endpoint selection.
export default function NativeAudioSettingsSection({ isDaylight, theme, className }: {
    isDaylight: boolean; theme?: Theme; className: string;
}) {
    const { t } = useTranslation();
    const autoFallback = useAudioSettingsStore(state => state.nativeAudioAutoFallback);
    const setAutoFallback = useAudioSettingsStore(state => state.handleSetNativeAudioAutoFallback);
    const backend = useAudioSettingsStore(state => state.nativeAudioBackend);
    const deviceId = useAudioSettingsStore(state => state.nativeAudioDeviceId);
    const apply = useAudioSettingsStore(state => state.handleSetNativeAudioOutput);
    const processingMode = useAudioSettingsStore(state => state.nativeAudioProcessingMode);
    const setProcessingMode = useAudioSettingsStore(state => state.handleSetNativeAudioProcessingMode);
    const [devices, setDevices] = useState<NativeAudioDevice[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const showSignalPath = useAudioSettingsStore(state => state.showAudioSignalPath);
    const setShowSignalPath = useAudioSettingsStore(state => state.handleSetShowAudioSignalPath);
    const [component, setComponent] = useState<NativeComponentStatus>({ available: false });
    const [componentNotice, setComponentNotice] = useState(false);
    const [available, setAvailable] = useState(false);
    const supported = isNativeAudioSupported();
    const refresh = async () => {
        if (!supported) return;
        setBusy(true); setError('');
        try {
            const status = await readNativeComponentStatus();
            setComponent(status);
            setAvailable(status.available);
            if (!status.available) { setError(t(nativeErrorKey({ code: status.errorCode || 'COMPONENT_UNAVAILABLE' }))); return false; }
            const next = await window.electron!.nativeAudio!.request({ action: 'devices' }) as NativeAudioDevice[];
            setDevices(next);
            return true;
        } catch (error) { setError(t(nativeErrorKey(error))); }
        finally { setBusy(false); }
    };
    const manage = async (action: string) => {
        setBusy(true); setError('');
        try { await window.electron!.nativeAudio!.request({ action }); if (await refresh()) setComponentNotice(false); }
        catch (error) { setError(t(nativeErrorKey(error))); }
        finally { setBusy(false); }
    };
    const requireComponent = async (change: () => void) => {
        setBusy(true);
        try {
            await withNativeAudioComponent(() => { setError(''); setAvailable(true); change(); }, status => {
                setComponent(status); setAvailable(false);
                setError(t(nativeErrorKey({ code: status.errorCode || 'COMPONENT_UNAVAILABLE' })));
                setComponentNotice(true);
            });
        } finally { setBusy(false); }
    };
    useEffect(() => { if (supported) void refresh(); }, [supported]);
    if (!supported) return null;
    const value = backend === 'browser' ? 'browser' : JSON.stringify([backend, deviceId]);
    const options = [
        { value: 'browser', label: t('nativeAudio.browser') },
        ...devices.map(device => ({ value: JSON.stringify([device.backend, device.id]),
            label: `${device.backend === 'asio' ? 'ASIO' : t('nativeAudio.wasapi')} — ${device.name}` })),
    ];
    if (!options.some(option => option.value === value)) options.push({ value, label: t('nativeAudio.savedUnavailable') });
    return <SettingsAnchor anchorId="nativeAudioOutput" label={t('nativeAudio.title')}>
        <SettingsSectionHeading icon={AudioLines} label={t('nativeAudio.title')} />
        <div className={`p-4 rounded-xl border ${className}`} style={{ color: 'var(--text-primary)' }}>
        <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('nativeAudio.title')}</h3>
            <button type="button" disabled={busy} onClick={() => void refresh()}
                aria-label={t('nativeAudio.refresh')} className="rounded-lg p-2 disabled:opacity-40">
                <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
            </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button type="button" disabled={busy || backend !== 'browser' || !component.installable}
                className="rounded-lg border px-3 py-2 disabled:opacity-40"
                onClick={() => void manage('component-install')}>{t('nativeAudio.installComponent')}</button>
            {component.installed && <button type="button" disabled={busy || backend !== 'browser'}
                className="rounded-lg border px-3 py-2 disabled:opacity-40"
                onClick={() => void manage('component-uninstall')}>{t('nativeAudio.removeComponent')}</button>}
            {!component.installable && <p>{t('nativeAudio.componentPending')}</p>}
            {component.updateAvailable && <span role="status">{t('nativeAudio.updateAvailable')}</span>}
            {component.version && <span>v{component.version}</span>}
        </div>
        <p className="my-3 text-xs opacity-70">{t('nativeAudio.description')}</p>
        <CustomSelect value={value} options={options} isDaylight={isDaylight} theme={theme}
            ariaLabel={t('nativeAudio.title')} disabled={busy}
            onChange={next => {
                const [mode, id] = next === 'browser' ? ['browser', ''] : JSON.parse(next) as [NativeAudioBackend, string];
                const change = () => { setError(''); setPlayerState(PlayerState.PAUSED); apply(mode as NativeAudioBackend, id); };
                if (mode === 'browser') change(); else void requireComponent(change);
            }} />
        {error && !componentNotice && <p role="alert" className="mt-2 text-xs">{error}</p>}
        {!available && <p className="mt-2 text-xs opacity-70">{t('nativeAudio.componentRequiredDescription')}</p>}
        <p className="mt-3 text-xs opacity-70">{t('nativeAudio.limitations')}</p>
        <div className="mt-4 flex items-center justify-between gap-4 text-sm">
            {t('nativeAudio.autoFallback')}
            <button type="button" role="switch" aria-checked={autoFallback} aria-label={t('nativeAudio.autoFallback')}
                disabled={busy} onClick={() => void requireComponent(() => setAutoFallback(!autoFallback))}
                className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${autoFallback ? '' : settingsToggleOffClassFor(isDaylight)}`}
                style={{ backgroundColor: autoFallback ? theme?.secondaryColor || 'rgba(114,119,134,1)' : undefined }}>
                <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${autoFallback ? 'translate-x-6' : 'translate-x-0'}`} />
            </button>
        </div>
        {available && !devices.some(device => device.backend === 'asio') &&
            <p className="mt-2 text-xs opacity-70">{t('nativeAudio.noAsio')}</p>}
        <div className="mt-4 flex items-start justify-between gap-4 border-t pt-4"
            style={{ borderColor: isDaylight ? 'rgba(24, 24, 27, 0.12)' : 'rgba(255, 255, 255, 0.1)' }}>
            <div className="min-w-0">
                <div className="text-sm font-medium">{t('nativeAudio.integerDirect')}</div>
                <div className="mt-1 max-w-[540px] text-[11px] leading-relaxed opacity-60">
                    {t('nativeAudio.integerDirectDescription')}
                </div>
            </div>
            <button type="button" role="switch" aria-checked={processingMode === 'integer-direct'}
                aria-label={t('nativeAudio.integerDirect')}
                disabled={busy} onClick={() => void requireComponent(() => {
                    setPlayerState(PlayerState.PAUSED);
                    setProcessingMode(processingMode === 'integer-direct' ? 'compatibility' : 'integer-direct');
                })}
                className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${
                    processingMode === 'integer-direct' ? '' : settingsToggleOffClassFor(isDaylight)}`}
                style={{ backgroundColor: processingMode === 'integer-direct'
                    ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}>
                <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    processingMode === 'integer-direct' ? 'translate-x-6' : 'translate-x-0'}`} />
            </button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 border-t pt-4 text-sm" style={{ borderColor: isDaylight ? 'rgba(24,24,27,0.12)' : 'rgba(255,255,255,0.1)' }}>
            {t('nativeAudio.showSignalPath')}
            <button type="button" role="switch" aria-checked={showSignalPath} aria-label={t('nativeAudio.showSignalPath')}
                disabled={busy} onClick={() => void requireComponent(() => setShowSignalPath(!showSignalPath))}
                className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors ${showSignalPath ? '' : settingsToggleOffClassFor(isDaylight)}`}
                style={{ backgroundColor: showSignalPath ? theme?.secondaryColor || 'rgba(114,119,134,1)' : undefined }}>
                <div className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${showSignalPath ? 'translate-x-6' : 'translate-x-0'}`} />
            </button>
        </div>
        </div>
        {createPortal(<ThemedDialog isOpen={componentNotice} isDaylight={isDaylight}
            title={t('nativeAudio.componentRequiredTitle')} closeDisabled={busy}
            onClose={() => setComponentNotice(false)}>
            <p role="alert" className="mb-3 text-sm">{error || t('nativeAudio.errors.COMPONENT_UNAVAILABLE')}</p>
            <p className="mb-4 text-sm opacity-70">{component.installable
                ? t('nativeAudio.componentRequiredDescription') : t('nativeAudio.componentPending')}</p>
            <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} className="rounded-xl border px-4 py-2 text-sm"
                    onClick={() => setComponentNotice(false)}>{t('localMusic.cancel')}</button>
                {component.installable && <button type="button" disabled={busy}
                    className="rounded-xl border px-4 py-2 text-sm disabled:opacity-40"
                    onClick={() => {
                        if (backend !== 'browser') { setPlayerState(PlayerState.PAUSED); apply('browser', ''); }
                        void manage('component-install');
                    }}>{t('nativeAudio.installComponent')}</button>}
            </div>
        </ThemedDialog>, document.body)}
    </SettingsAnchor>;
}
