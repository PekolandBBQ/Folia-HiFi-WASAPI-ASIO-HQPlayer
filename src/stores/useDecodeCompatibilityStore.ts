import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// Compatibility is opt-in. A one-song choice belongs only to the abortable recovery request.
export const useDecodeCompatibilityStore = create<{ enabled: boolean; setEnabled: (enabled: boolean) => void;
    prompt: { id: string; choose: (choice: 'once' | 'always' | 'cancel') => void } | null }>(set => ({
    enabled: getStoredBoolean('folia_decode_compatibility', false), prompt: null,
    setEnabled: enabled => { setStoredBoolean('folia_decode_compatibility', enabled); set({ enabled }); },
}));
export function requestDecodeCompatibility(id: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        useDecodeCompatibilityStore.getState().prompt?.choose('cancel');
        const choose = (choice: 'once' | 'always' | 'cancel') => {
            signal.removeEventListener('abort', abort);
            if (useDecodeCompatibilityStore.getState().prompt?.id === id) useDecodeCompatibilityStore.setState({ prompt: null });
            if (choice === 'always' && !signal.aborted) useDecodeCompatibilityStore.getState().setEnabled(true);
            resolve(choice !== 'cancel' && !signal.aborted);
        };
        const abort = () => choose('cancel');
        signal.addEventListener('abort', abort, { once: true });
        useDecodeCompatibilityStore.setState({ prompt: { id, choose } });
    });
}
