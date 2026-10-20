// src/services/onlineMusic/spotifyActivation.ts — session intent, never inferred from a saved account/provider.
export function createSpotifyActivation() {
    let selected = false;
    const listeners = new Set<() => void>();
    return {
        selected: () => selected,
        select() {
            if (selected) return;
            selected = true;
            console.info('[Spotify source] 用户已明确选择 Spotify，开始准备连接');
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        wait(signal?: AbortSignal): Promise<void> {
            if (signal?.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
            if (selected) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const finish = () => { listeners.delete(finish); signal?.removeEventListener('abort', abort); resolve(); };
                const abort = () => { listeners.delete(finish); reject(new DOMException('Request cancelled', 'AbortError')); };
                listeners.add(finish); signal?.addEventListener('abort', abort, { once: true });
            });
        },
    };
}
export const spotifyActivation = createSpotifyActivation();
