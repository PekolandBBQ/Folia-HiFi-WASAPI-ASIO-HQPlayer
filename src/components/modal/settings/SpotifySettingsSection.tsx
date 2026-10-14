import { useEffect, useState } from 'react';
import { Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../../services/onlineMusic/omni';
import type { ProviderConnectionSettings } from '../../../types/onlineMusic';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { CustomSelect } from '../../shared/CustomSelect';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SpotifyPlaybackSetup from './SpotifyPlaybackSetup';
import SpotifyDesktopSetup from '../../app/home/SpotifyDesktopSetup';

// Public OAuth settings use Omni and the existing settings surfaces; no credential is editable here.
export default function SpotifySettingsSection({ settingsCardClass }: { settingsCardClass: string }) {
    const { t } = useTranslation();
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    const [value, setValue] = useState<ProviderConnectionSettings | null>(null);
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        void omni.getProviderConnectionSettings('spotify').then(settings => { if (active) setValue(settings); })
            .catch(() => { if (active) setMessage(t('spotifySettings.readFailed')); });
        return () => { active = false; };
    }, [t]);
    const save = async () => {
        if (!value) return;
        setBusy(true); setMessage('');
        try {
            const result = await omni.setProviderConnectionSettings('spotify', value);
            setValue(result.settings); setMessage(t(result.changed ? 'spotifySettings.saved' : 'spotifySettings.unchanged'));
        } catch { setMessage(t('spotifySettings.saveFailed')); }
        finally { setBusy(false); }
    };
    const disabled = busy || value?.readOnly;
    if (value?.playbackMode === 'wrapper') return <SettingsAnchor anchorId="spotifyConnection" label={t('spotifySettings.title')}>
        <SettingsSectionHeading icon={Music2} label={t('spotifySettings.title')} />
        <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
            <p className="text-xs leading-relaxed">Spotify 通过本机 Wrapper 连接。设备由 Folia 自动识别，播放时准备路由和采集；无需填写 Client ID 或手动确认采样率。</p>
            <SpotifyDesktopSetup showCompletion={false} onMode={() => {}} onReady={() => setMessage('组件配置与连接已完成。实际音频输出将在播放时确认。')} />
            {message && <p role="status" className="text-xs">{message}</p>}
        </div>
    </SettingsAnchor>;
    return <SettingsAnchor anchorId="spotifyConnection" label={t('spotifySettings.title')}>
        <SettingsSectionHeading icon={Music2} label={t('spotifySettings.title')} />
        <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
            <p className="text-xs opacity-65 leading-relaxed">{t('spotifySettings.description')}</p>
            <p className="text-xs opacity-65 leading-relaxed">{t('spotifyLibrary.apiNotice')}</p>
            {value && <>
                <CustomSelect ariaLabel={t('spotifySettings.mode')} value={value.mode} disabled={disabled} isDaylight={daylight} frosted
                    onChange={mode => setValue({ ...value, mode: mode as 'shared' | 'custom', ...(mode === 'custom' && value.mode === 'shared' ? { clientId: '', redirectUri: 'http://127.0.0.1:43821/callback' } : {}) })}
                    options={[{ value: 'custom', label: t('spotifySettings.custom') }, { value: 'shared', label: t('spotifySettings.shared') }]} />
                {value.mode === 'custom' && <div className="space-y-3">
                    <label className="block text-xs">Client ID<input aria-label="Spotify Client ID" autoComplete="off" spellCheck={false}
                        className="mt-1 block w-full rounded-lg border border-current/15 bg-transparent px-3 py-2 text-sm" value={value.clientId} disabled={disabled}
                        onChange={event => setValue({ ...value, clientId: event.target.value.trim() })} /></label>
                    <label className="block text-xs">{t('spotifySettings.callback')}<input aria-label={t('spotifySettings.callback')} autoComplete="off" spellCheck={false}
                        className="mt-1 block w-full rounded-lg border border-current/15 bg-transparent px-3 py-2 text-sm" value={value.redirectUri} disabled={disabled}
                        onChange={event => setValue({ ...value, redirectUri: event.target.value.trim() })} /></label>
                </div>}
                <p className="text-xs opacity-60">{t(value.readOnly ? 'spotifySettings.managed' : 'spotifySettings.changeHint')}</p>
                <button type="button" disabled={disabled} onClick={() => void save()} className="rounded-full border border-current/15 bg-current/5 px-4 py-2 text-xs hover:bg-current/10 disabled:opacity-40">
                    {t(busy ? 'spotifySettings.saving' : 'spotifySettings.save')}
                </button>
            </>}
            {message && <p role="status" aria-label={t('spotifySettings.title')} className="text-xs leading-relaxed">{message}</p>}
            {omni.hasProviderPlaybackSetup('spotify') && <SpotifyPlaybackSetup />}
        </div>
    </SettingsAnchor>;
}
