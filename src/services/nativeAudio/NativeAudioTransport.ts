import { prepareWithCompatibility } from './prepareWithCompatibility';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad } from '../../stores/usePlaybackLoadStore';
import type { NativeAudioApi, NativeAudioBackend, NativeAudioEvent, NativeAudioProcessingMode, NativeAudioState } from '../../types/nativeAudio';
import { publishSignalPath, clearSignalPath } from '../../stores/useSignalPathStore';
import { getNativeErrorCode } from './errors';
import { loadNativeOnlineSource } from './loadOnlineSource';
import { loadNativeLocalFile } from './loadLocalFile';

// src/services/nativeAudio/NativeAudioTransport.ts — the media transport subset consumed by Folia.
// It is an EventTarget, not a patched DOM element. The only HTMLAudioElement cast is at the
// deck boundary; Web Audio explicitly rejects this adapter before creating any graph nodes.
export class NativeAudioTransport extends EventTarget {
    readonly nativeAudio = true;
    src = '';
    duration = NaN;
    paused = true;
    ended = false;
    readyState = 0;
    seeking = false;
    error: { code: number; message: string; nativeCode: string } | null = null;
    loop = false;
    playbackRate = 1;
    defaultPlaybackRate = 1;
    preservesPitch = true;
    private position = 0;
    private presentedTime = 0;
    private timestamp = 0;
    private outputLatency = 0;
    private hqplayerGainDb = -2;
    private rememberHQPlayerGain = false;
    private onHQPlayerGainObserved: (gainDb: number) => void = () => {};
    setHQPlayerGainSettings(gainDb: number, remember: boolean, onObserved: (gainDb: number) => void) {
        const changed = gainDb !== this.hqplayerGainDb;
        this.hqplayerGainDb = gainDb; this.rememberHQPlayerGain = remember; this.onHQPlayerGainObserved = onObserved;
        if (this.backend === 'hqplayer' && this.readyState && changed) {
            void this.command('gain', { gainDb }).then(state => this.apply(state)).catch(error => this.fail(error));
        }
    }
    private level = 1;
    private replayGain = 1;
    setReplayGain(gain: number) {
        this.replayGain = Number.isFinite(gain) ? Math.max(0, Math.min(16, gain)) : 1;
        if (this.readyState) void this.command('replaygain', { gain: this.replayGain }).then(state => this.apply(state)).catch(error => this.fail(error));
    }
    private silent = false;
    private session = '';
    private abort = new AbortController();
    private loading: Promise<void> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private intent = 0;
    private revision = 0;
    private disposed = false;
    private unsubscribe: () => void;
    constructor(private api: NativeAudioApi, private backend: NativeAudioBackend, private deviceId: string,
        private processingMode: NativeAudioProcessingMode,
        private getFile: () => Promise<File | null>) {
        super();
        this.unsubscribe = api.onEvent(event => this.receive(event));
    }
    get currentSrc() { return this.src; }
    get currentTime() {
        const elapsed = this.paused || this.seeking ? 0 : Math.min(this.backend === 'hqplayer' ? 2 : 0.12, (performance.now() - this.timestamp) / 1000);
        // IPC snapshots can lag the interpolated frame already shown. Hold that frame until
        // the device catches up; do not repeatedly rewind lyric animations on every packet.
        this.presentedTime = Math.max(this.presentedTime,
            Math.min(Number.isFinite(this.duration) ? this.duration : Infinity, this.position + elapsed));
        return this.presentedTime;
    }
    set currentTime(value: number) {
        if (!Number.isFinite(value)) return;
        this.position = Math.max(0, Math.min(Number.isFinite(this.duration) ? this.duration : value, value));
        this.presentedTime = this.position;
        this.timestamp = performance.now(); this.ended = false; this.seeking = true;
        const revision = ++this.revision;
        this.emit('seeking');
        void this.command('seek', { position: this.position }).then(state => {
            if (revision !== this.revision) return;
            this.seeking = false; this.apply(state); this.emit('seeked'); this.emit('timeupdate');
        }).catch(error => this.fail(error));
    }
    get volume() { return this.level; }
    set volume(value: number) { this.level = Math.max(0, Math.min(1, value)); this.syncVolume(); }
    get muted() { return this.silent; }
    set muted(value: boolean) { this.silent = value; this.syncVolume(); }
    get buffered(): TimeRanges {
        const duration = this.duration;
        return { length: this.readyState >= 2 ? 1 : 0, start: () => 0, end: () => duration };
    }
    get seekable() { return this.buffered; }
    getAttribute(name: string) { return name === 'src' ? this.src || null : null; }
    removeAttribute(name: string) { if (name === 'src') this.setSource(''); }
    setAttribute(name: string, value: string) { if (name === 'src') this.setSource(value); }
    fastSeek(value: number) { this.currentTime = value; }
    asMediaElement() { return this as unknown as HTMLAudioElement; }

    setSource(src: string) {
        if (this.src === src) return;
        this.cancel(); this.src = src; this.position = 0; this.duration = NaN;
        this.presentedTime = 0;
        this.readyState = 0; this.error = null; this.ended = false; this.paused = true;
        this.loading = null; this.queue = Promise.resolve();
        if (src) this.load();
    }
    load() {
        if (!this.src || this.loading || this.disposed) return;
        this.session = crypto.randomUUID();
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const session = this.session;
        beginPlaybackLoad(session, 'load');
        this.emit('loadstart');
        this.loading = (async () => {
            const file = await this.getFile();
            signal.throwIfAborted();
            const song = usePlaybackStore.getState().currentSong;
            const trackKey = song ? getPlaybackSongKey(song) : this.src;
            const state = await prepareWithCompatibility(session, signal, async compatibilityMode => file
                ? await loadNativeLocalFile(this.api, session, file, this.backend, this.deviceId, signal, this.processingMode, this.hqplayerGainDb, trackKey, compatibilityMode)
                : await loadNativeOnlineSource(this.api, session, this.src, this.backend, this.deviceId, signal, this.processingMode, this.hqplayerGainDb, trackKey, compatibilityMode));
            this.apply(state); this.readyState = 4;
            endPlaybackLoad(session);
            this.emit('loadedmetadata'); this.emit('loadeddata'); this.emit('canplay');
        })();
        void this.loading.catch(error => { if (!signal.aborted) this.fail(error); });
    }
    async play() {
        if (this.error && this.src) {
            const source = this.src;
            this.setSource(''); this.setSource(source);
        }
        const intent = ++this.intent;
        const session = this.session;
        await this.loading;
        if (this.disposed || session !== this.session || intent !== this.intent)
            throw new DOMException('Playback cancelled', 'AbortError');
        if (!this.readyState || this.error) throw new Error(this.error?.message || 'No local file loaded');
        await this.command('volume', { volume: this.silent ? 0 : this.level });
        await this.command('replaygain', { gain: this.replayGain });
        if (intent !== this.intent) throw new DOMException('Playback cancelled', 'AbortError');
        if (this.backend === 'hqplayer') beginPlaybackLoad(session, 'buffer');
        const state = await this.command('play');
        if (intent !== this.intent || session !== this.session) throw new DOMException('Playback cancelled', 'AbortError');
        this.apply(state); this.emit('play'); this.emit('playing');
    }
    pause() {
        endPlaybackLoad(this.session);
        ++this.intent;
        const wasPaused = this.paused;
        this.position = this.currentTime; this.paused = true;
        this.seeking = false;
        const revision = ++this.revision;
        if (!wasPaused) { this.emit('pause'); this.emit('timeupdate'); }
        if (this.readyState) void this.command('pause').then(state => {
            if (revision === this.revision) this.apply(state);
        }).catch(error => this.fail(error));
    }
    private command(action: string, values: { position?: number; volume?: number; gain?: number; gainDb?: number } = {}) {
        const session = this.session;
        const run = this.queue.catch(() => {}).then(async () => {
            await this.loading;
            if (this.disposed || session !== this.session) throw new DOMException('Playback cancelled', 'AbortError');
            try {
                const state = await this.api.request({ action, session, ...values }) as NativeAudioState;
                if (this.disposed || session !== this.session) throw new DOMException('Playback cancelled', 'AbortError');
                return state;
            } catch (error) {
                if (this.disposed || session !== this.session) throw new DOMException('Playback cancelled', 'AbortError');
                this.fail(error);
                throw error;
            }
        });
        this.queue = run;
        return run;
    }
    private syncVolume() {
        if (!this.readyState) return;
        void this.command('volume', { volume: this.silent ? 0 : this.level }).catch(error => this.fail(error));
    }
    private apply(state: NativeAudioState) {
        if (state.session !== this.session) return;
        publishSignalPath(state);
        if (state.playing && state.position > 0) endPlaybackLoad(this.session);
        const wasPaused = this.paused;
        const now = performance.now();
        const hqplayerStartupDelay = this.backend === 'hqplayer' && state.playing && state.position === 0
            && state.latency > this.outputLatency + 0.01;
        const hqplayerSeekDelay = this.backend === 'hqplayer' && this.seeking && state.playing && state.latency > 0;
        const delayedHqplayerAnchor = hqplayerStartupDelay || hqplayerSeekDelay;
        const repeatedHqplayerSample = this.backend === 'hqplayer' && state.playing && !wasPaused
            && Math.abs(state.position - this.position) < 0.0005 && !delayedHqplayerAnchor;
        const stoppedAtStart = !state.playing && !state.ended && state.position === 0;
        if ((this.ended && !state.ended) || stoppedAtStart || delayedHqplayerAnchor) this.presentedTime = state.position;
        this.position = state.position;
        if (hqplayerSeekDelay || (hqplayerStartupDelay && wasPaused)) this.timestamp = now + state.latency * 1000;
        else if (hqplayerStartupDelay) this.timestamp += (state.latency - this.outputLatency) * 1000;
        else if (!repeatedHqplayerSample) this.timestamp = now;
        this.duration = state.duration; this.outputLatency = state.latency;
        this.paused = !state.playing; this.ended = state.ended;
        if (this.backend === 'hqplayer' && this.rememberHQPlayerGain && Number.isFinite(state.hqplayerGainDb)) {
            const observed = Math.round(Math.max(-120, Math.min(0, state.hqplayerGainDb!)) * 10) / 10;
            if (observed !== this.hqplayerGainDb) {
                this.hqplayerGainDb = observed;
                this.onHQPlayerGainObserved(observed);
            }
        }
    }
    private receive(event: NativeAudioEvent) {
        if (this.disposed || event.session !== this.session) return;
        if (event.event === 'progress' && event.progress) { updatePlaybackLoad(this.session, event.progress); return; }
        if (event.event === 'error') { this.fail(Object.assign(new Error(event.errorCode || 'NATIVE_REQUEST_FAILED'), { code: event.errorCode })); return; }
        if (event.event === 'resume' && this.backend === 'hqplayer' && event.state) {
            this.apply(event.state); this.emit('timeupdate'); this.emit('play'); this.emit('playing'); return;
        }
        if (!event.state || this.seeking || (this.paused && event.state.playing)) return;
        const wasEnded = this.ended; const wasPaused = this.paused;
        this.apply(event.state); this.emit('timeupdate');
        if (this.ended && !wasEnded) {
            if (this.loop) { void this.play().catch(error => this.fail(error)); }
            else this.emit('ended');
        } else if (!wasPaused && this.paused) this.emit('pause');
    }
    private fail(error: unknown) {
        if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        endPlaybackLoad(this.session);
        const message = getNativeErrorCode(error);
        if (message === 'CANCELLED') return;
        if (this.error?.message === message) return;
        this.position = this.currentTime; this.paused = true; this.seeking = false;
        this.error = { code: message === 'DECODE_FAILED' ? 3 : ['SOURCE_EXPIRED', 'SOURCE_UNAVAILABLE'].includes(message) ? 2 : 4, message, nativeCode: message };
        this.emit('error');
    }
    private emit(name: string) { if (!this.disposed) this.dispatchEvent(new Event(name)); }
    private cancel() {
        ++this.intent; ++this.revision; this.seeking = false;
        this.abort.abort();
        clearSignalPath(this.session);
        endPlaybackLoad(this.session);
        if (this.session) void this.api.request({ action: 'stop', session: this.session }).catch(() => {});
        this.session = '';
    }
    async stopForRecovery() {
        this.abort.abort();
        if (this.session) await this.api.request({ action: 'stop', session: this.session });
    }
    async retryFrom(position: number, playing: boolean) {
        const source = this.src;
        this.setSource(''); this.setSource(source);
        await this.resumeFrom(position, playing);
    }
    async resumeFrom(position: number, playing: boolean) {
        await this.loading;
        // Desktop initializes its playlist/DSP on Play, which can reset an earlier seek.
        if (playing && this.backend === 'hqplayer') await this.play();
        const state = await this.command('seek', { position });
        this.presentedTime = state.position; this.apply(state);
        this.emit('seeked'); this.emit('timeupdate');
        if (playing && this.backend !== 'hqplayer') await this.play();
    }
    dispose() { this.disposed = true; this.cancel(); this.unsubscribe(); }
}

export const isNativeAudioElement = (element: HTMLAudioElement | null): boolean =>
    Boolean(element && 'nativeAudio' in element);

// A refreshed provider URL can be byte-for-byte identical. React then has no src change to apply.
export function reloadRecoveredNativeSource(element: HTMLAudioElement, source: string | null, onReady?: () => void) {
    if (!isNativeAudioElement(element) || !source || !element.error || element.currentSrc !== source) return false;
    if (onReady) element.addEventListener('canplay', onReady, { once: true });
    element.removeAttribute('src');
    element.setAttribute('src', source);
    return true;
}
