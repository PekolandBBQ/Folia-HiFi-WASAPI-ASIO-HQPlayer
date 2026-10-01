import type { NativeAudioBackend } from '../../types/nativeAudio';

// The settings store requests a handoff; only the mounted player owns the live media element.
type Prepare = (backend: NativeAudioBackend, deviceId: string) => () => void;
let prepare: Prepare | null = null;
export function registerOutputHandoff(handler: Prepare) {
    prepare = handler;
    return () => { if (prepare === handler) prepare = null; };
}
export const prepareOutputHandoff: Prepare = (backend, deviceId) => prepare?.(backend, deviceId) || (() => {});
