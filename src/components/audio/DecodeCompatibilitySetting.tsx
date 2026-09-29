import { useTranslation } from 'react-i18next';
import { useDecodeCompatibilityStore } from '../../stores/useDecodeCompatibilityStore';
import SettingsSwitch from '../shared/SettingsSwitch';

// Recovery policy is independent of native PCM precision and normal browser decoding.
export default function DecodeCompatibilitySetting() {
    const { t } = useTranslation();
    const { enabled, setEnabled } = useDecodeCompatibilityStore();
    return <label className="flex items-start justify-between gap-4 py-3 text-sm" style={{ color: 'var(--text-primary)' }}>
        <span>{t('loadProgress.compatibility')}<span className="block mt-1 text-xs opacity-60">{t('loadProgress.compatibilityDesc')}</span></span>
        <SettingsSwitch label={t('loadProgress.compatibility')} checked={enabled} onChange={setEnabled} />
    </label>;
}
