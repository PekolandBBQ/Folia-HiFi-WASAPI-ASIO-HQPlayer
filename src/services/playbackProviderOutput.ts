// src/services/playbackProviderOutput.ts: renderer outputs acknowledge quiescence before a provider route exits.
const outputs = new Map<string, Set<() => Promise<void>>>();
export function registerPlaybackProviderOutput(providerId: string, release: () => Promise<void>) {
    const entries = outputs.get(providerId) || new Set<() => Promise<void>>();
    outputs.set(providerId, entries); entries.add(release);
    return () => { entries.delete(release); if (!entries.size) outputs.delete(providerId); };
}
export async function releasePlaybackProviderOutputs(providerId: string) {
    await Promise.all([...outputs.get(providerId) || []].map(release => release()));
}
