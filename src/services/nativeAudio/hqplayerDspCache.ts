import type { HQPlayerDspCatalog, HQPlayerDspSettings } from '../../types/hqplayerDsp';

// One session-scoped request is shared by prewarming and both editors; never launches HQPlayer.
let session = '';
let cached: HQPlayerDspCatalog | null = null;
let pending: Promise<HQPlayerDspCatalog> | null = null;
let revision = 0;
export const getHQPlayerDspCache = () => cached;
export function setHQPlayerDspSession(next: string) {
    if (next === session) return;
    session = next; cached = null; pending = null; ++revision;
}
export function readHQPlayerDsp(): Promise<HQPlayerDspCatalog> {
    if (pending) return pending;
    const ticket = revision;
    const request = window.electron!.nativeAudio!.request({ action: 'hqplayer-dsp-read' }) as Promise<HQPlayerDspCatalog>;
    pending = request.then(result => {
        if (ticket === revision) cached = result;
        return result;
    }).finally(() => { if (ticket === revision) pending = null; });
    return pending;
}
export function invalidateHQPlayerDsp() { cached = null; pending = null; ++revision; }
export function dspDraft(data: HQPlayerDspCatalog): HQPlayerDspSettings {
    const current = data.catalogs[data.state.mode];
    return data.pending || { mode: data.state.mode,
        filter: current?.filters.find(item => item.index === data.state.filter)?.name || '',
        shaper: current?.shapers.find(item => item.index === data.state.shaper)?.name || '',
        rate: current?.rates.find(item => item.index === data.state.rate)?.rate ?? 0 };
}
