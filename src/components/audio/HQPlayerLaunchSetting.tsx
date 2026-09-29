import { useTranslation } from 'react-i18next';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import SettingsSwitch from '../shared/SettingsSwitch';

// Foreground is the default; this preference never hides an already-running user instance.
export default function HQPlayerLaunchSetting() {
    const { t } = useTranslation();
    const silent = useHQPlayerSettingsStore(state => state.silentLaunch);
    const setSilent = useHQPlayerSettingsStore(state => state.setSilentLaunch);
    return <label className="my-4 flex items-center justify-between gap-4 text-sm">
        <span>{t('hqpLaunch.silent')}<span className="mt-1 block text-xs opacity-60">{t('hqpLaunch.silentDescription')}</span></span>
        <SettingsSwitch label={t('hqpLaunch.silent')} checked={silent} onChange={setSilent} />
    </label>;
}
