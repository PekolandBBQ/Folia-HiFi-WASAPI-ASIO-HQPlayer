import { create } from 'zustand';
import { setStatusMessage } from './useStatusMessageStore';
import { nativeErrorKey } from '../services/nativeAudio/errors';
import i18n from '../i18n/config';

// Share observed window state between floating/default settings; never start or stop playback.
type WindowState = { running: boolean; visible: boolean; controllable: boolean };
let pending: Promise<void> | null = null;
export const useHQPlayerWindowStore = create<WindowState & { busy: boolean }>(() => ({ running: false, visible: false, controllable: false, busy: false }));
export function refreshHQPlayerWindow(visible?: boolean): Promise<void> {
    if (pending) return pending;
    useHQPlayerWindowStore.setState({ busy: true });
    pending = (async () => {
        try {
            const result = await window.electron!.nativeAudio!.request({ action: 'hqplayer-window', ...(visible === undefined ? {} : { visible }) }) as WindowState;
            useHQPlayerWindowStore.setState(result);
        } catch (error) {
            if (visible !== undefined) setStatusMessage({ type: 'error', text: i18n.t(nativeErrorKey(error)) });
        } finally { useHQPlayerWindowStore.setState({ busy: false }); pending = null; }
    })();
    return pending;
}
