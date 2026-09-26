import { useEffect, useState } from 'react';
import { AudioLines, RefreshCw } from 'lucide-react';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { useTranslation } from 'react-i18next';
import { CustomSelect } from '../../shared/CustomSelect';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { setPlayerState } from '../../../stores/usePlaybackStore';
import { isNativeAudioSupported } from '../../../services/nativeAudio/capabilities';
import { PlayerState, type Theme } from '../../../types';
import type { NativeAudioBackend, NativeAudioDevice } from '../../../types/nativeAudio';

// src/components/modal/settings/NativeAudioSettingsSection.tsx — native backend and endpoint selection.
export default function NativeAudioSettingsSection({ isDaylight, theme, className }: {
    isDaylight: boolean; theme?: Theme; className: string;
}) {
    const { t } = useTranslation();
    const backend = useAudioSettingsStore(state => state.nativeAudioBackend);
    const deviceId = useAudioSettingsStore(state => state.nativeAudioDeviceId);
    const apply = useAudioSettingsStore(state => state.handleSetNativeAudioOutput);
    const [devices, setDevices] = useState<NativeAudioDevice[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [available, setAvailable] = useState(false);
    const supported = isNativeAudioSupported();
    const refresh = async () => {
        if (!supported) return;
        setBusy(true); setError('');
        try {
            const status = await window.electron!.nativeAudio!.request({ action: 'status' }) as { available: boolean };
            setAvailable(status.available);
            if (!status.available) { setError(t('nativeAudio.unavailable')); return; }
            const next = await window.electron!.nativeAudio!.request({ action: 'devices' }) as NativeAudioDevice[];
            setDevices(next);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
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
        <p className="my-3 text-xs opacity-70">{t('nativeAudio.description')}</p>
        <CustomSelect value={value} options={options} isDaylight={isDaylight} theme={theme}
            ariaLabel={t('nativeAudio.title')} disabled={busy}
            onChange={next => {
                const [mode, id] = next === 'browser' ? ['browser', ''] : JSON.parse(next) as [NativeAudioBackend, string];
                if (mode !== 'browser' && !available) return;
                setPlayerState(PlayerState.PAUSED);
                apply(mode as NativeAudioBackend, id);
            }} />
        <p className="mt-3 text-xs opacity-70">{t('nativeAudio.limitations')}</p>
        {available && !devices.some(device => device.backend === 'asio') &&
            <p className="mt-2 text-xs opacity-70">{t('nativeAudio.noAsio')}</p>}
        {error && <p role="alert" className="mt-2 text-xs">{error}</p>}
        </div>
    </SettingsAnchor>;
}
