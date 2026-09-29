import { create } from 'zustand';

// A single abortable consent request; switching songs/output cancels the previous decision.
export const useHQPlayerConnectionStore = create<{ prompt: { choose: (connect: boolean) => void } | null }>(() => ({ prompt: null }));
export function confirmExistingHQPlayer(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        useHQPlayerConnectionStore.getState().prompt?.choose(false);
        const choose = (connect: boolean) => {
            signal?.removeEventListener('abort', abort);
            if (useHQPlayerConnectionStore.getState().prompt?.choose === choose) useHQPlayerConnectionStore.setState({ prompt: null });
            resolve(connect && !signal?.aborted);
        };
        const abort = () => choose(false);
        signal?.addEventListener('abort', abort, { once: true });
        useHQPlayerConnectionStore.setState({ prompt: { choose } });
    });
}
