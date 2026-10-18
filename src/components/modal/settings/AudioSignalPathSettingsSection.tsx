import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { isNativeAudioSupported } from '../../../services/nativeAudio/capabilities';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import SettingsSwitch from '../../shared/SettingsSwitch';
// Shared display preference is independent of output device readiness.
export default function AudioSignalPathSettingsSection({ className }: { className: string }) {
 const {t}=useTranslation();
 const shown=useAudioSettingsStore(s=>s.showAudioSignalPath);
 const setShown=useAudioSettingsStore(s=>s.handleSetShowAudioSignalPath);
 if(!isNativeAudioSupported())return null;
 return <SettingsAnchor anchorId="audioSignalPath" label={t('audioSignalPath.title')}>
  <SettingsSectionHeading icon={Activity} label={t('audioSignalPath.title')} />
  <div className={'p-4 rounded-xl border '+className}>
   <label className="flex items-center justify-between gap-4 text-sm">{t('nativeAudio.showSignalPath')}
    <SettingsSwitch checked={shown} onChange={setShown} label={t('nativeAudio.showSignalPath')} />
   </label>
  </div>
 </SettingsAnchor>;
}

