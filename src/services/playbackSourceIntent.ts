// src/services/playbackSourceIntent.ts: passive rehydration does not acquire output or leave a provider.
let passiveSource: string | null = null;
export function markPassivePlaybackSource(source: string) { passiveSource = source; }
export function activatePlaybackSource(source: string | null | undefined) {
    if (source === passiveSource) passiveSource = null;
}
export const isPassivePlaybackSource = (source: string) => source === passiveSource;
