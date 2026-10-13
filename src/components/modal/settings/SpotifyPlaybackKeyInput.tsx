import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { spotifyPlaybackSetup } from '../../../services/onlineMusic/spotifyPlaybackSetup';
import { useSpotifyPlaybackSetup } from '../../../hooks/useSpotifyPlaybackSetup';

// The entered key lives only in this mounted password form and the IPC save
// request. Reopening never reads the encrypted key back into the renderer.
export default function SpotifyPlaybackKeyInput() {
    const { t } = useTranslation();
    const busy = useSpotifyPlaybackSetup(state => state.busy);
    const [keyValue, setKeyValue] = useState('');
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const save = async () => {
        const saved = await spotifyPlaybackSetup.run({ operation: 'saveKey', keyValue });
        if (saved && mounted.current) setKeyValue('');
    };
    const buttonClass = 'rounded-full border border-current/15 bg-current/5 px-4 py-2 text-xs hover:bg-current/10 disabled:opacity-40';
    return <div className="space-y-3">
        <label className="block text-xs">{t('spotifyPlayback.key')}
            <input type="password" aria-label={t('spotifyPlayback.key')} autoComplete="off" spellCheck={false} value={keyValue}
                disabled={busy} onChange={event => setKeyValue(event.target.value.trim())}
                className="mt-1 block w-full rounded-lg border border-current/15 bg-transparent px-3 py-2 text-sm" />
        </label>
        <p className="text-xs opacity-60 leading-relaxed">{t('spotifyPlayback.keyHint')}</p>
        <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={!spotifyPlaybackSetup.canRun('saveKey') || !keyValue} onClick={() => void save()}>{t('spotifyPlayback.saveKey')}</button>
            <button type="button" className={buttonClass} disabled={!spotifyPlaybackSetup.canRun('keyPage')} onClick={() => void spotifyPlaybackSetup.run({ operation: 'keyPage' })}>{t('spotifyPlayback.getKey')}</button>
        </div>
    </div>;
}
