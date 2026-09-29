import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { nativeErrorKey } from './errors';
import i18n from '../../i18n/config';

// Keep the current backend selected until HQPlayer has exited and released its DAC.
let closing: Promise<boolean> | null = null;
export function releaseHQPlayerOutput(): Promise<boolean> {
    if (!closing) closing = (async () => {
        try {
            const { setPlayerState } = await import('../../stores/usePlaybackStore');
            const { PlayerState } = await import('../../types');
            setPlayerState(PlayerState.PAUSED);
            await window.electron?.nativeAudio?.request({ action: 'hqplayer-shutdown' });
            return true;
        } catch (error) {
            setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey(error)) });
            return false;
        } finally { closing = null; }
    })();
    return closing;
}
