import { requestDecodeCompatibility, useDecodeCompatibilityStore } from '../../stores/useDecodeCompatibilityStore';

// The opt-in applies to this preparation only unless the listener explicitly persists it.
export async function prepareWithCompatibility<T>(session: string, signal: AbortSignal, load: (enabled: boolean) => Promise<T>): Promise<T> {
    try { return await load(useDecodeCompatibilityStore.getState().enabled); }
    catch (error) {
        if ((error as { code?: string }).code === 'HQPLAYER_CONFIRM_EXISTING' && !signal.aborted) {
            const { authorizeHQPlayerConnection } = await import('./hqplayerSettings');
            if (!await authorizeHQPlayerConnection(signal)) throw new DOMException('HQPlayer connection cancelled', 'AbortError');
            signal.throwIfAborted();
            return prepareWithCompatibility(session, signal, load);
        }
        if ((error as { code?: string }).code !== 'STRICT_DECODE_FAILED' || signal.aborted) throw error;
        if (!await requestDecodeCompatibility(session, signal)) throw error;
        signal.throwIfAborted();
        return load(true);
    }
}
