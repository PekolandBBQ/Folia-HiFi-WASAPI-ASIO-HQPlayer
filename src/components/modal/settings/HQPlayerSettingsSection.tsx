import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Radio, RefreshCw } from 'lucide-react';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { isNativeAudioSupported } from '../../../services/nativeAudio/capabilities';
import { readHQPlayerStatus, withHQPlayer, chooseHQPlayerPath, type HQPlayerStatus } from '../../../services/nativeAudio/hqplayerSettings';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { useHQPlayerSettingsStore } from '../../../stores/useHQPlayerSettingsStore';
import { setPlayerState } from '../../../stores/usePlaybackStore';
import { PlayerState } from '../../../types';

// src/components/modal/settings/HQPlayerSettingsSection.tsx — external player setup, separate from the native helper.
export default function HQPlayerSettingsSection({ className }: { className: string }) {
    const { t } = useTranslation();
    const backend = useAudioSettingsStore(state => state.nativeAudioBackend);
    const apply = useAudioSettingsStore(state => state.handleSetNativeAudioOutput);
    const signalPath = useAudioSettingsStore(state => state.showAudioSignalPath);
    const setSignalPath = useAudioSettingsStore(state => state.handleSetShowAudioSignalPath);
    const gainDb = useHQPlayerSettingsStore(state => state.gainDb);
    const remember = useHQPlayerSettingsStore(state => state.remember);
    const setGain = useHQPlayerSettingsStore(state => state.setGain);
    const setRemember = useHQPlayerSettingsStore(state => state.setRemember);
    const [configuration, setConfiguration] = useState<HQPlayerStatus>({ available: false });
    const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false);
    const supported = isNativeAudioSupported();
    const refresh = async () => { setBusy(true); try { const status = await readHQPlayerStatus(); setAvailable(status.available); setConfiguration(status); } finally { setBusy(false); } };
    useEffect(() => { if (supported) void refresh(); }, [supported]);
    if (!supported) return null;
    const change = async (run: () => void) => {
        setBusy(true);
        try { setAvailable(await withHQPlayer(run)); } finally { setBusy(false); }
    };
    const choosePath = async (reset = false) => {
        setBusy(true);
        try { const status = await chooseHQPlayerPath(reset); if (status) { setConfiguration(status); setAvailable(status.available); } }
        finally { setBusy(false); }
    };
    return <SettingsAnchor anchorId="hqPlayerOutput" label={t('hqPlayer.title')}>
        <SettingsSectionHeading icon={Radio} label={t('hqPlayer.title')} />
        <div className={`p-4 rounded-xl border ${className}`}>
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t('hqPlayer.title')}</h3>
                <button type="button" disabled={busy} aria-label={t('hqPlayer.refresh')} onClick={() => void refresh()}><RefreshCw size={16} /></button>
            </div>
            <p className="my-3 text-xs opacity-70">{t('hqPlayer.description')}</p>
            {!available && <p role="status" className="my-3 text-sm">{t('hqPlayer.installRequired')}</p>}
            <p className="my-3 text-xs opacity-70">{t('hqPlayer.controlHint')}</p>
            <p className="my-3 break-all text-xs" data-testid="hqplayer-program-path">{t(configuration.custom ? 'hqPlayer.customPath' : 'hqPlayer.autoPath')}: {configuration.executablePath || t('hqPlayer.notFound')}</p>
            <div className="my-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40" onClick={() => void choosePath()}>{t('hqPlayer.selectPath')}</button>
                <button type="button" disabled={busy || !configuration.custom} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40" onClick={() => void choosePath(true)}>{t('hqPlayer.resetPath')}</button>
            </div>
            <button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40"
                onClick={() => {
                    const run = () => { setPlayerState(PlayerState.PAUSED); apply(backend === 'hqplayer' ? 'browser' : 'hqplayer', backend === 'hqplayer' ? '' : 'hqplayer-local'); };
                    if (backend === 'hqplayer') run(); else void change(run);
                }}>{t(backend === 'hqplayer' ? 'hqPlayer.disable' : 'hqPlayer.enable')}</button>
            <label className="mt-4 flex items-center justify-between gap-4 text-sm">
                {t('hqPlayer.gain')}
                <input type="number" min={-120} max={0} step={0.1} value={gainDb} disabled={busy || !available}
                    aria-label={t('hqPlayer.gain')} className="w-24 rounded-lg border bg-transparent px-2 py-1 disabled:opacity-40"
                    onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) void change(() => setGain(value)); }} />
            </label>
            <p className="mt-2 text-xs opacity-70">{t('hqPlayer.gainDescription')}</p>
            <label className="mt-4 flex items-center justify-between gap-4 text-sm">
                {t('hqPlayer.remember')}
                <input type="checkbox" role="switch" aria-checked={remember} aria-label={t('hqPlayer.remember')}
                    checked={remember} disabled={busy || !available} onChange={() => void change(() => setRemember(!remember))} />
            </label>
            <label className="mt-4 flex items-center justify-between gap-4 text-sm">
                {t('nativeAudio.showSignalPath')}
                <input type="checkbox" role="switch" aria-checked={signalPath} aria-label={t('nativeAudio.showSignalPath')}
                    checked={signalPath} disabled={busy || !available} onChange={() => void change(() => setSignalPath(!signalPath))} />
            </label>
        </div>
    </SettingsAnchor>;
}
