import { isNativeAudioSupported } from './capabilities';
import { getNativeErrorCode, nativeErrorKey } from './errors';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { setPlayerState } from '../../stores/usePlaybackStore';
import { PlayerState } from '../../types';
import i18n from '../../i18n/config';

// src/services/nativeAudio/hqplayerSettings.ts — HQPlayer availability is independent of the WASAPI/ASIO helper.
export type HQPlayerStatus = { available: boolean; errorCode?: string; executablePath?: string; custom?: boolean; canceled?: boolean };
export async function readHQPlayerStatus(): Promise<HQPlayerStatus> {
    if (!isNativeAudioSupported()) return { available: false, errorCode: 'HQPLAYER_UNAVAILABLE' };
    try { return await window.electron!.nativeAudio!.request({ action: 'hqplayer-status' }) as HQPlayerStatus; }
    catch (error) { return { available: false, errorCode: getNativeErrorCode(error) }; }
}
export async function withHQPlayer(change: () => void): Promise<boolean> {
    const status = await readHQPlayerStatus();
    if (!status.available) {
        useSettingsModalStore.getState().openSettings('options', 'playback', null, 'hqPlayerOutput');
        setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey({ code: status.errorCode || 'HQPLAYER_UNAVAILABLE' })) });
        return false;
    }
    change(); return true;
}

export async function toggleHQPlayerOutput() {
    const switchOutput = () => {
        const settings = useAudioSettingsStore.getState();
        const enabled = settings.nativeAudioBackend === 'hqplayer';
        setPlayerState(PlayerState.PAUSED);
        settings.handleSetNativeAudioOutput(enabled ? 'browser' : 'hqplayer', enabled ? '' : 'hqplayer-local');
    };
    if (useAudioSettingsStore.getState().nativeAudioBackend === 'hqplayer') switchOutput();
    else await withHQPlayer(switchOutput);
}
export async function toggleHQPlayerRememberGain() {
    await withHQPlayer(() => { const settings = useHQPlayerSettingsStore.getState(); settings.setRemember(!settings.remember); });
}

export async function chooseHQPlayerPath(reset = false): Promise<HQPlayerStatus | null> {
    if (!isNativeAudioSupported()) return null;
    try {
        const result = await window.electron!.nativeAudio!.request({ action: reset ? 'hqplayer-reset-executable' : 'hqplayer-select-executable' }) as HQPlayerStatus;
        if (result.canceled) return null;
        const settings = useAudioSettingsStore.getState();
        if (settings.nativeAudioBackend === 'hqplayer') {
            setPlayerState(PlayerState.PAUSED); settings.handleSetNativeAudioOutput('browser', '');
        }
        return result;
    } catch (error) {
        setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey(error)) }); return null;
    }
}
