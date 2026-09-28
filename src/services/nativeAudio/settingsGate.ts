import i18n from '../../i18n/config';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { getNativeErrorCode, nativeErrorKey } from './errors';
import { isNativeAudioSupported } from './capabilities';

// src/services/nativeAudio/settingsGate.ts — recheck component readiness before committing a dependent setting.
export type NativeComponentStatus = {
    available: boolean; installed?: boolean; installable?: boolean; version?: string;
    updateAvailable?: boolean; errorCode?: string;
};

export async function readNativeComponentStatus(): Promise<NativeComponentStatus> {
    try {
        const api = window.electron?.nativeAudio;
        if (!isNativeAudioSupported()) return { available: false, errorCode: 'COMPONENT_UNAVAILABLE' };
        return await api!.request({ action: 'status' }) as NativeComponentStatus;
    } catch (error) {
        return { available: false, errorCode: getNativeErrorCode(error) };
    }
}

export async function withNativeAudioComponent(
    apply: () => void,
    unavailable: (status: NativeComponentStatus) => void = status => {
        useSettingsModalStore.getState().openSettings('options', 'playback', null, 'nativeAudioOutput');
        setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey({ code: status.errorCode || 'COMPONENT_UNAVAILABLE' })) });
    },
): Promise<boolean> {
    const status = await readNativeComponentStatus();
    if (!status.available) { unavailable(status); return false; }
    apply();
    return true;
}
