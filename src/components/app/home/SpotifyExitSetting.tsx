import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSwitch from '../../shared/SettingsSwitch';
import { requestSpotify } from '../../../services/onlineMusic/spotifyTransport';
// Persist in the desktop profile so quit needs no renderer callback.
export default function SpotifyExitSetting() {
 const {t}=useTranslation();
 const [checked,setChecked]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState('');
 async function update(value?:boolean){setBusy(true);setError('');try{
  const result=await requestSpotify<{quitOnFoliaExit:boolean}>({action:'desktopSetup',operation:'preferences',...(value===undefined?{}:{preferences:{quitOnFoliaExit:value}})});
  setChecked(result.quitOnFoliaExit);
 }catch{setError(t('spotifyExit.saveFailed'));}finally{setBusy(false);}}
 useEffect(()=>{void update();},[]);
 return <div className="space-y-2 border-t border-current/15 pt-3">
  <label className="flex items-center justify-between gap-4 text-sm">{t('spotifyExit.title')}
   <SettingsSwitch label={t('spotifyExit.title')} checked={checked} disabled={busy} onChange={value=>void update(value)} />
  </label>{error&&<p role="alert">{error}</p>}
 </div>;
}

