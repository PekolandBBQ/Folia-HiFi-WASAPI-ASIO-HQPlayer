import { isNativeAudioSupported } from './capabilities';
import { getNativeErrorCode, nativeErrorKey } from './errors';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { setPlayerState } from '../../stores/usePlaybackStore';
import { PlayerState } from '../../types';
import i18n from '../../i18n/config';
import { confirmExistingHQPlayer } from '../../stores/useHQPlayerConnectionStore';

// src/services/nativeAudio/hqplayerSettings.ts — HQPlayer availability is independent of the WASAPI/ASIO helper.
export type HQPlayerStatus = { available: boolean; errorCode?: string; executablePath?: string; custom?: boolean; canceled?: boolean; needsConfirmation?: boolean; instancePid?: number; running?: boolean;
    component?: { available: boolean; installed: boolean; installable: boolean; version?: string; updateAvailable?: boolean; rollbackAvailable?: boolean; busy?: boolean; errorCode?: string } };
export function restorePreviousHQPlayerOutput() {
    const settings = useAudioSettingsStore.getState();
    if (settings.nativeAudioBackend !== 'hqplayer') return;
    let previous = { backend: 'browser' as 'browser' | 'wasapi-exclusive' | 'asio', deviceId: '' };
    try {
        const saved = JSON.parse(localStorage.getItem('folia_hqplayer_previous_output') || 'null');
        if (saved && ['browser', 'wasapi-exclusive', 'asio'].includes(saved.backend) && typeof saved.deviceId === 'string') previous = saved;
    } catch { /* A missing previous setting falls back to browser playback. */ }
    setPlayerState(PlayerState.PAUSED);
    // Declining an existing-instance connection must leave that unconnected instance untouched.
    settings.handleSetNativeAudioOutput(previous.backend, previous.deviceId, false);
}
export async function authorizeHQPlayerConnection(signal?: AbortSignal, status?: HQPlayerStatus): Promise<boolean> {
    const current = status || await readHQPlayerStatus();
    if (signal?.aborted) return false;
    if (current.needsConfirmation) {
        if (!await confirmExistingHQPlayer(signal)) {
            if (!signal?.aborted) restorePreviousHQPlayerOutput();
            return false;
        }
        await window.electron!.nativeAudio!.request({ action: 'hqplayer-authorize-existing', instancePid: current.instancePid });
    }
    await window.electron!.nativeAudio!.request({ action: 'hqplayer-launch-options', silent: useHQPlayerSettingsStore.getState().silentLaunch });
    return true;
}
export async function readHQPlayerStatus(): Promise<HQPlayerStatus> {
    if (!isNativeAudioSupported()) return { available: false, errorCode: 'HQPLAYER_UNAVAILABLE' };
    try { return await window.electron!.nativeAudio!.request({ action: 'hqplayer-status' }) as HQPlayerStatus; }
    catch (error) { return { available: false, errorCode: getNativeErrorCode(error) }; }
}
export async function manageHQPlayerComponent(action: 'install' | 'uninstall' | 'rollback'): Promise<HQPlayerStatus> {
    return await window.electron!.nativeAudio!.request({ action: `hqplayer-component-${action}` }) as HQPlayerStatus;
}
export async function withHQPlayer(change: () => void): Promise<boolean> {
    const status = await readHQPlayerStatus();
    if (!status.available) {
        useSettingsModalStore.getState().openSettings('options', 'playback', null, 'hqPlayerOutput');
        setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey({ code: status.errorCode || 'HQPLAYER_UNAVAILABLE' })) });
        return false;
    }
    try {
        if (!await authorizeHQPlayerConnection(undefined, status)) return false;
        change(); return true;
    } catch (error) { setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey(error)) }); return false; }
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
