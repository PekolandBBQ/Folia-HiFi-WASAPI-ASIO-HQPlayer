import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { normalizeLivePcmPrebufferMs } from '../../utils/livePcmPrebuffer';
import { prepareWithCompatibility } from './prepareWithCompatibility';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad, usePlaybackLoadStore, type LoadProgress } from '../../stores/usePlaybackLoadStore';
import type { NativeAudioApi, NativeAudioBackend, NativeAudioEvent, NativeAudioProcessingMode, NativeAudioState } from '../../types/nativeAudio';
import { publishSignalPath, clearSignalPath, beginSignalPath, failSignalPath } from '../../stores/useSignalPathStore';
import { getNativeErrorCode } from './errors';
import { loadNativeOnlineSource } from './loadOnlineSource';
import { loadNativeLocalFile } from './loadLocalFile';
import { mediaTimeRange, readNativeBufferState, streamingReadyState, type NativeBufferState } from './streamingMediaState';
import { requestDecodeCompatibility } from '../../stores/useDecodeCompatibilityStore';
import { nextPrivateDiagnosticRef, recordPrivateNativeError } from '../debug/privateDiagnostics';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { normalizeHQPlayerSpotifyExperiment } from '../../utils/hqplayerSpotifyExperiment';

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
    private nativePosition = 0;
    // Initial streaming checkpoints and duplicate-seek avoidance reconstructed from r31.
    private initialPosition: number | undefined;
    private preparedResumePosition: number | null = null;
    private preparedResumeIntent: ReturnType<NativeAudioTransport['getPlaybackIntent']> | null = null;
    private deferredLoad = false;
    private outputReleased = false;
    private preparationRevision = 0;
    private pausedPreparationRevision = 0;
    private presentedTime = 0;
    private timestamp = 0;
    private outputLatency = 0;
    private buffer: NativeBufferState = { streaming: false, buffering: false, start: 0, end: 0, complete: false };
    private downloadProgress: LoadProgress | null = null;
    private metadataLoaded = false;
    private compatibilitySource = '';
    private compatibilityUsed = false;
    private recoverySession = '';
    private recoveryPlaying = false;
    private recoveryTask: Promise<void> | null = null;
    private hqplayerGainDb = -2;
    private rememberHQPlayerGain = false;
    private onHQPlayerGainObserved: (gainDb: number) => void = () => {};
    setHQPlayerGainSettings(gainDb: number, remember: boolean, onObserved: (gainDb: number) => void) {
        const changed = gainDb !== this.hqplayerGainDb;
        this.hqplayerGainDb = gainDb; this.rememberHQPlayerGain = remember; this.onHQPlayerGainObserved = onObserved;
        if (this.backend === 'hqplayer' && this.readyState && !this.outputReleased && changed) {
            void this.command('gain', { gainDb }).then(state => this.apply(state)).catch(error => this.fail(error, 'gain'));
        }
    }
    private level = 1;
    private replayGain = 1;
    setReplayGain(gain: number) {
        this.replayGain = Number.isFinite(gain) ? Math.max(0, Math.min(16, gain)) : 1;
        if (this.readyState && !this.outputReleased) void this.command('replaygain', { gain: this.replayGain }).then(state => this.apply(state)).catch(error => this.fail(error, 'replaygain'));
    }
    private silent = false;
    private session = '';
    private diagnosticRef = 0;
    private abort = new AbortController();
    private loading: Promise<void> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private streamingControls: Promise<unknown> = Promise.resolve();
    private intent = 0;
    private playbackIntent: Readonly<{ playing: boolean }> = Object.freeze({ playing: false });
    private requestedPlayback: boolean | null = null;
    private seekIntent: Readonly<{ position: number }> | null = null;
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
    // Request identities stay stable during refill; an explicit seek is independent of play/pause.
    getPlaybackIntent() { return Object.freeze({ playback: this.playbackIntent, seek: this.seekIntent }); }
    // A newly preparing deck has no playback request yet; it is not a listener Pause.
    getRequestedPlaybackIntent() { return this.requestedPlayback; }
    // Output transfer uses acknowledged native frames, never the lyric interpolation clock.
    getOutputPosition() {
        if (!this.loading) return this.initialPosition ?? this.position;
        return this.seeking && this.seekIntent ? this.seekIntent.position : this.nativePosition;
    }
    get currentTime() {
        const outputLead = this.backend === 'hqplayer' ? 2 : 0.12;
        const lead = this.buffer.streaming ? Math.min(outputLead, Math.max(0, this.buffer.end - this.position)) : outputLead;
        const elapsed = this.paused || this.seeking || this.buffer.buffering ? 0 : Math.min(lead, (performance.now() - this.timestamp) / 1000);
        // IPC snapshots can lag the interpolated frame already shown. Hold that frame until
        // the device catches up; do not repeatedly rewind lyric animations on every packet.
        this.presentedTime = Math.max(this.presentedTime,
            Math.min(Number.isFinite(this.duration) && this.duration > 0 ? this.duration : Infinity, this.position + elapsed));
        return this.presentedTime;
    }
    set currentTime(value: number) {
        if (!Number.isFinite(value)) return;
        this.position = Math.max(0, Math.min(Number.isFinite(this.duration) && this.duration > 0 ? this.duration : value, value));
        this.seekIntent = Object.freeze({ position: this.position });
        this.presentedTime = this.position;
        this.timestamp = performance.now(); this.ended = false; this.seeking = true;
        const revision = ++this.revision;
        this.emit('seeking');
        if (!this.loading) {
            this.initialPosition = this.position; this.seeking = false;
            this.emit('seeked'); this.emit('timeupdate'); return;
        }
        void this.command('seek', { position: this.position }).then(state => {
            if (revision !== this.revision) return;
            this.seeking = false; this.presentedTime = state.position; this.apply(state); this.emit('seeked'); this.emit('timeupdate');
        }).catch(error => {
            if (revision !== this.revision) return;
            // A cancelled checkpoint has no newer setter to clear its flag. Keep the
            // acknowledged output clock authoritative and allow subsequent state ticks.
            this.seeking = false;
            if (getNativeErrorCode(error) === 'CANCELLED' || error instanceof DOMException && error.name === 'AbortError') {
                this.position = this.nativePosition; this.presentedTime = this.nativePosition;
                console.info('[NativeAudioSeek]', { outcome: 'cancelled-checkpoint-released', session: this.session,
                    requestedPosition: this.seekIntent?.position, acknowledgedPosition: this.nativePosition,
                    revision, preparationRevision: this.preparationRevision });
                this.emit('seeked'); this.emit('timeupdate');
                return;
            }
            this.fail(error, 'seek');
        });
    }
    get volume() { return this.level; }
    set volume(value: number) { this.level = Math.max(0, Math.min(1, value)); this.syncVolume(); }
    get muted() { return this.silent; }
    set muted(value: boolean) { this.silent = value; this.syncVolume(); }
    get buffered(): TimeRanges {
        return this.buffer.streaming ? mediaTimeRange(this.buffer.start, this.buffer.end, this.readyState >= 2)
            : mediaTimeRange(0, this.duration, this.readyState >= 2);
    }
    get seekable() { return mediaTimeRange(0, this.duration, this.readyState >= 1); }
    getAttribute(name: string) { return name === 'src' ? this.src || null : null; }
    removeAttribute(name: string) { if (name === 'src') this.setSource(''); }
    setAttribute(name: string, value: string) { if (name === 'src') this.setSource(value); }
    fastSeek(value: number) { this.currentTime = value; }
    asMediaElement() { return this as unknown as HTMLAudioElement; }

    setSource(src: string, initialPosition?: number, deferLoad = false) {
        if (this.src === src) return;
        this.cancel(); this.src = src; this.duration = NaN; this.requestedPlayback = null;
        this.initialPosition = Number.isFinite(initialPosition) && initialPosition! >= 0 ? initialPosition : undefined;
        this.deferredLoad = deferLoad; this.outputReleased = false; this.preparationRevision = 0; this.pausedPreparationRevision = 0;
        this.position = deferLoad ? this.initialPosition ?? 0 : 0; this.nativePosition = this.position;
        this.presentedTime = this.position;
        this.buffer = { streaming: false, buffering: false, start: 0, end: 0, complete: false };
        this.downloadProgress = null; this.metadataLoaded = false;
        if (src && src !== this.compatibilitySource) this.compatibilitySource = '';
        this.compatibilityUsed = false; this.recoverySession = '';
        this.readyState = 0; this.error = null; this.ended = false; this.paused = true;
        this.loading = null; this.queue = Promise.resolve(); this.streamingControls = Promise.resolve();
        if (src && !deferLoad) this.load();
    }
    load() {
        if (!this.src || this.loading || this.disposed) return;
        this.session = crypto.randomUUID();
        this.diagnosticRef = nextPrivateDiagnosticRef();
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const session = this.session;
        const initialPosition = this.initialPosition;
        const preparedIntent = this.getPlaybackIntent();
        this.deferredLoad = false;
        // Changes and revocation affect the next preparation, never an active playback transaction.
        const livePcmPrebufferMs = normalizeLivePcmPrebufferMs(useAudioSettingsStore.getState().livePcmPrebufferMs);
        const spotifyExperiment = this.backend === 'hqplayer'
            ? normalizeHQPlayerSpotifyExperiment(useHQPlayerSettingsStore.getState().spotifyExperiment) : undefined;
        beginSignalPath(session);
        beginPlaybackLoad(session, 'load');
        this.emit('loadstart');
        this.loading = (async () => {
            const file = await this.getFile();
            signal.throwIfAborted();
            const song = usePlaybackStore.getState().currentSong;
            const trackKey = song ? getPlaybackSongKey(song) : this.src;
            const state = await prepareWithCompatibility(session, signal, async compatibilityMode => {
                compatibilityMode ||= this.compatibilitySource === this.src;
                this.compatibilityUsed = compatibilityMode;
                return file
                    ? await loadNativeLocalFile(this.api, session, file, this.backend, this.deviceId, signal, this.processingMode, this.hqplayerGainDb, trackKey, compatibilityMode)
                    : await loadNativeOnlineSource(this.api, session, this.src, this.backend, this.deviceId, signal, this.processingMode, this.hqplayerGainDb, trackKey, compatibilityMode, spotifyExperiment, initialPosition, livePcmPrebufferMs);
            });
            signal.throwIfAborted();
            this.apply(state);
            if (initialPosition !== undefined && state.streaming && !state.playing && Math.abs(state.position - initialPosition) <= .001) {
                this.preparedResumePosition = initialPosition; this.preparedResumeIntent = preparedIntent;
            }
            if (!this.buffer.streaming) { this.readyState = 4; endPlaybackLoad(session); }
            this.metadataLoaded = true;
            this.emit('loadedmetadata'); this.emit('loadeddata');
            if (this.readyState >= 3) this.emit('canplay');
        })();
        void this.loading.catch(error => { if (!signal.aborted) this.fail(error, 'begin'); });
    }
    async play() {
        if (this.recoverySession === this.session && this.recoveryTask) {
            this.requestedPlayback = true;
            this.playbackIntent = Object.freeze({ playing: true });
            const source = this.src; this.recoveryPlaying = true;
            await this.recoveryTask;
            if (this.disposed || source !== this.src) throw new DOMException('Playback cancelled', 'AbortError');
            if (this.error) throw new Error(this.error.message);
            return;
        }
        if (this.error && this.src) {
            const source = this.src;
            this.setSource(''); this.setSource(source);
        }
        const deferredPosition = this.deferredLoad ? this.initialPosition ?? this.position : null;
        if (!this.loading) this.load();
        this.playbackIntent = Object.freeze({ playing: true }); this.requestedPlayback = true;
        const intent = ++this.intent;
        const session = this.session;
        const assertPlayIntent = () => {
            if (this.disposed || session !== this.session || intent !== this.intent)
                throw new DOMException('Playback cancelled', 'AbortError');
        };
        await this.loading;
        assertPlayIntent();
        if (!this.readyState || this.error) throw new Error(this.error?.message || 'No local file loaded');
        await this.command('volume', { volume: this.silent ? 0 : this.level });
        assertPlayIntent();
        await this.command('replaygain', { gain: this.replayGain });
        assertPlayIntent();
        if (this.backend === 'hqplayer') {
            await this.command('gain', { gainDb: this.hqplayerGainDb });
            assertPlayIntent();
        }
        if (deferredPosition !== null && (this.preparedResumePosition === null || Math.abs(deferredPosition - this.preparedResumePosition) > .001)) {
            if (this.backend === 'hqplayer' && !this.buffer.streaming) {
                await this.command('play');
                assertPlayIntent();
            }
            const state = await this.command('seek', { position: deferredPosition });
            if (intent !== this.intent) throw new DOMException('Playback cancelled', 'AbortError');
            this.presentedTime = state.position; this.apply(state);
        }
        this.preparedResumePosition = null; this.preparedResumeIntent = null;
        if (this.backend === 'hqplayer') beginPlaybackLoad(session, 'buffer');
        const state = await this.command('play');
        if (intent !== this.intent || session !== this.session) throw new DOMException('Playback cancelled', 'AbortError');
        this.outputReleased = false; this.presentedTime = state.position; this.apply(state, false); this.emit('play');
        this.emit(this.buffer.buffering ? 'waiting' : 'playing');
    }
    pause() {
        this.requestedPlayback = false;
        this.playbackIntent = Object.freeze({ playing: false });
        if (this.recoverySession === this.session) this.recoveryPlaying = false;
        endPlaybackLoad(this.session);
        this.outputReleased = true; this.pausedPreparationRevision = this.preparationRevision;
        ++this.intent;
        const wasPaused = this.paused;
        this.position = this.readyState ? this.currentTime : this.initialPosition ?? this.currentTime; this.presentedTime = this.position; this.paused = true;
        this.seeking = false;
        const revision = ++this.revision;
        if (!wasPaused) { this.emit('pause'); this.emit('timeupdate'); }
        if (this.loading && !this.readyState) {
            // Initial finish/prebuffer may still own capture. Retire it immediately rather
            // than queueing Pause behind its completion; Play will prepare a fresh session.
            const checkpoint = this.position;
            this.cancel('handoff'); this.loading = null; this.queue = Promise.resolve(); this.streamingControls = Promise.resolve();
            this.initialPosition = checkpoint; this.deferredLoad = true;
            this.emit('playbackintentchange');
            return;
        }
        this.emit('playbackintentchange');
        if (this.loading) void this.command('pause').then(state => {
            if (revision === this.revision) this.apply(state);
        }).catch(error => this.fail(error, 'pause'));
    }
    private command(action: string, values: { position?: number; volume?: number; gain?: number; gainDb?: number } = {}) {
        const session = this.session, revision = this.revision, intent = this.intent, playbackIntent = this.playbackIntent;
        // Only an explicit Play/Seek may carry the next target. Moving the slider has no IPC side effects.
        const prebuffer = ['play', 'seek'].includes(action)
            ? { livePcmPrebufferMs: normalizeLivePcmPrebufferMs(useAudioSettingsStore.getState().livePcmPrebufferMs) } : {};
        // A seek changes position, not the user's pause intent. Only a newer
        // play/pause intent or session may retire a pending pause.
        const replacedControl = () => action === 'pause' && playbackIntent !== this.playbackIntent
            || action === 'play' && (intent !== this.intent || revision !== this.revision);
        const execute = async () => {
            await this.loading;
            if (this.disposed || session !== this.session || replacedControl()) throw new DOMException('Playback cancelled', 'AbortError');
            try {
                const state = await this.api.request({ action, session, ...values, ...prebuffer }) as NativeAudioState;
                if (this.disposed || session !== this.session || replacedControl()) throw new DOMException('Playback cancelled', 'AbortError');
                return state;
            } catch (error) {
                if (this.disposed || session !== this.session || replacedControl()) throw new DOMException('Playback cancelled', 'AbortError');
                if (action !== 'seek') this.fail(error, action);
                throw error;
            }
        };
        // A far progressive seek can wait on future download bytes. A newer seek must be
        // able to replace that decoder, and pause/gain must not sit behind its refill.
        const replacingSeek = this.buffer.streaming && action === 'seek';
        const streamingControl = this.buffer.streaming && ['pause', 'volume', 'replaygain', 'gain'].includes(action);
        const preceding = streamingControl ? this.streamingControls : this.queue;
        const run = replacingSeek || (streamingControl && action === 'pause')
            ? execute() : preceding.catch(() => {}).then(execute);
        if (streamingControl) {
            // Pause bypasses outstanding controls; retain all acknowledgements for
            // HQPlayer handoff without putting them behind a PCM-waiting play.
            this.streamingControls = Promise.all([preceding.catch(() => {}), run]);
            void this.streamingControls.catch(() => {});
        } else if (!replacingSeek) this.queue = run;
        return run;
    }
    private syncVolume() {
        if (!this.readyState || this.outputReleased) return;
        void this.command('volume', { volume: this.silent ? 0 : this.level }).catch(error => this.fail(error, 'volume'));
    }
    private acceptPreparationRevision(revision: number | undefined) {
        if (revision === undefined) return this.preparationRevision === 0;
        if (!Number.isSafeInteger(revision) || revision < this.preparationRevision) return false;
        this.preparationRevision = revision;
        return true;
    }
    private apply(state: NativeAudioState, emitPlaybackTransitions = true) {
        if (state.session !== this.session || !this.acceptPreparationRevision(state.preparationRevision)) return;
        publishSignalPath(state);
        if (!state.streaming && state.playing && state.position > 0) endPlaybackLoad(this.session);
        const wasPaused = this.paused;
        const previousBuffer = this.buffer; const previousReadyState = this.readyState; const previousDuration = this.duration;
        this.buffer = readNativeBufferState(state);
        const now = performance.now();
        const hqplayerStartupDelay = this.backend === 'hqplayer' && state.playing && state.position === 0
            && state.latency > this.outputLatency + 0.01;
        const hqplayerSeekDelay = this.backend === 'hqplayer' && this.seeking && state.playing && state.latency > 0;
        const delayedHqplayerAnchor = hqplayerStartupDelay || hqplayerSeekDelay;
        const repeatedHqplayerSample = this.backend === 'hqplayer' && state.playing && !wasPaused
            && Math.abs(state.position - this.position) < 0.0005 && !delayedHqplayerAnchor;
        const stoppedAtStart = !state.playing && !state.ended && state.position === 0;
        if ((this.ended && !state.ended) || stoppedAtStart || delayedHqplayerAnchor) this.presentedTime = state.position;
        this.position = state.position; this.nativePosition = state.position;
        if (hqplayerSeekDelay || (hqplayerStartupDelay && wasPaused)) this.timestamp = now + state.latency * 1000;
        else if (hqplayerStartupDelay) this.timestamp += (state.latency - this.outputLatency) * 1000;
        else if (!repeatedHqplayerSample) this.timestamp = now;
        // A progressive source's zero duration is an unknown hint, not a zero-length song.
        // Keep percentages indeterminate until metadata or producer EOF establishes its length.
        this.duration = this.buffer.streaming && state.duration === 0 && !this.buffer.complete ? NaN : state.duration;
        this.outputLatency = state.latency;
        this.paused = !state.playing; this.ended = state.ended && (!this.buffer.streaming || this.buffer.complete);
        if (this.buffer.streaming) {
            this.readyState = streamingReadyState(this.buffer, state.position, state.duration);
            if (this.buffer.buffering && state.playing) {
                if (!previousBuffer.buffering || wasPaused) beginPlaybackLoad(this.session, 'buffer');
                updatePlaybackLoad(this.session, { stage: 'buffer', loaded: Math.max(0, this.buffer.end - state.position) * 1000, total: state.livePcmPrebufferMs ?? 350, unit: 'milliseconds' });
            } else if (this.downloadProgress) updatePlaybackLoad(this.session, this.downloadProgress);
            else if (this.buffer.complete || previousBuffer.buffering || (state.playing && this.readyState >= 3)) endPlaybackLoad(this.session);
            if (this.metadataLoaded) {
                if (previousBuffer.start !== this.buffer.start || previousBuffer.end !== this.buffer.end) this.emit('progress');
                if (!Object.is(previousDuration, this.duration)) this.emit('durationchange');
                if (previousReadyState < 3 && this.readyState >= 3) this.emit('canplay');
                if (emitPlaybackTransitions && state.playing) {
                    if (this.buffer.buffering && (!previousBuffer.buffering || wasPaused)) this.emit('waiting');
                    else if (previousBuffer.buffering && !this.buffer.buffering) this.emit('playing');
                }
            }
        }
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
        if (this.recoverySession === this.session) return;
        if (event.event === 'progress' && event.progress) {
            if (!this.acceptPreparationRevision(event.progress.preparationRevision)) return;
            const currentResume = this.playbackIntent.playing && event.progress.preparationRevision !== undefined
                && event.progress.preparationRevision > this.pausedPreparationRevision;
            if (this.outputReleased && !currentResume) return;
            if (event.progress.complete) {
                this.downloadProgress = null;
                if (!this.buffer.buffering || this.paused) endPlaybackLoad(this.session);
            } else {
                if (!usePlaybackLoadStore.getState().owner && this.playbackIntent.playing) beginPlaybackLoad(this.session, event.progress.stage);
                if (event.progress.stage === 'download') this.downloadProgress = event.progress;
                if (!this.buffer.buffering || this.paused || event.progress.stage !== 'download') updatePlaybackLoad(this.session, event.progress);
            }
            return;
        }
        if (event.event === 'error') {
            const error = Object.assign(new Error(event.errorCode || 'NATIVE_REQUEST_FAILED'), { code: event.errorCode });
            if (event.errorCode === 'STRICT_DECODE_FAILED' && this.buffer.streaming && this.metadataLoaded && !this.compatibilityUsed)
                this.recoverStrictDecode(error);
            else this.fail(error);
            return;
        }
        if (event.event === 'resume' && this.backend === 'hqplayer' && event.state) {
            // An explicit DSP restart has already completed its new seek-and-play transaction.
            // Retire any old setter; it can still reject after this checkpoint arrives.
            const wasSeeking = this.seeking; ++this.revision;
            this.presentedTime = event.state.position;
            this.apply(event.state); this.seeking = false;
            if (wasSeeking) this.emit('seeked');
            this.emit('timeupdate'); this.emit('play'); this.emit('playing'); return;
        }
        if (!event.state || this.seeking || (this.paused && event.state.playing) || !this.acceptPreparationRevision(event.state.preparationRevision)) return;
        const wasEnded = this.ended; const wasPaused = this.paused;
        this.apply(event.state); this.emit('timeupdate');
        if (this.ended && !wasEnded) {
            if (this.loop) { void this.play().catch(error => this.fail(error, 'play')); }
            else this.emit('ended');
        } else if (!wasPaused && this.paused) this.emit('pause');
    }
    private fail(error: unknown, operation = 'unknown') {
        if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        endPlaybackLoad(this.session);
        const message = getNativeErrorCode(error);
        if (message === 'CANCELLED') return;
        recordPrivateNativeError(operation, { code: message }, this.diagnosticRef);
        failSignalPath(this.session, message);
        if (this.error?.message === message) return;
        this.position = this.currentTime; this.paused = true; this.seeking = false;
        this.error = { code: message === 'DECODE_FAILED' ? 3 : ['SOURCE_EXPIRED', 'SOURCE_UNAVAILABLE'].includes(message) ? 2 : 4, message, nativeCode: message };
        this.emit('error');
    }
    // A decoder can fail after prebuffered playback starts; preserve the checkpoint until the listener chooses recovery.
    private recoverStrictDecode(error: Error) {
        const session = this.session, source = this.src, signal = this.abort.signal, position = this.currentTime;
        this.recoverySession = session; this.recoveryPlaying = !this.paused;
        this.position = position; this.timestamp = performance.now();
        this.buffer = { ...this.buffer, buffering: true };
        beginPlaybackLoad(session, 'buffer');
        if (this.recoveryPlaying) this.emit('waiting');
        let reloadSession = session;
        let task!: Promise<void>;
        task = (async () => {
            try {
                const accepted = await requestDecodeCompatibility(session, signal);
                if (signal.aborted || this.disposed || session !== this.session) return;
                if (!accepted) { this.fail(error, 'begin'); return; }
                const playing = this.recoveryPlaying;
                this.compatibilitySource = source;
                this.setSource(''); this.setSource(source); reloadSession = this.session;
                await this.resumeFrom(position, playing);
            } catch (failure) {
                if (!this.disposed && reloadSession === this.session) this.fail(failure, 'begin');
            } finally {
                if (this.recoveryTask === task) this.recoveryTask = null;
                if (this.recoverySession === session) this.recoverySession = '';
            }
        })();
        this.recoveryTask = task;
    }
    private emit(name: string) { if (!this.disposed) this.dispatchEvent(new Event(name)); }
    private cancel(reason?: 'handoff') {
        this.playbackIntent = Object.freeze({ playing: false });
        this.seekIntent = null; this.preparedResumePosition = null; this.preparedResumeIntent = null;
        ++this.intent; ++this.revision; this.seeking = false;
        this.abort.abort();
        clearSignalPath(this.session);
        endPlaybackLoad(this.session);
        if (this.session) void this.api.request({ action: 'stop', session: this.session, ...(reason ? { reason } : {}) }).catch(() => {});
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
        this.requestedPlayback = playing;
        if (!this.loading && !playing) {
            this.currentTime = position; this.paused = true; return;
        }
        if (!this.loading) { this.initialPosition = position; this.load(); }
        const session = this.session, playbackIntent = this.playbackIntent, seekIntent = this.seekIntent;
        await this.loading;
        if (this.disposed || session !== this.session || seekIntent !== this.seekIntent) throw new DOMException('Playback cancelled', 'AbortError');
        if (playbackIntent !== this.playbackIntent) playing = this.playbackIntent.playing;
        const preparedPosition = this.preparedResumePosition, preparedIntent = this.preparedResumeIntent;
        this.preparedResumePosition = null; this.preparedResumeIntent = null;
        if (preparedPosition !== null && preparedIntent) {
            if (preparedIntent.seek !== this.seekIntent) throw new DOMException('Playback cancelled', 'AbortError');
            if (preparedIntent.playback !== this.playbackIntent) playing = this.playbackIntent.playing;
        }
        if (preparedPosition !== null && Math.abs(position - preparedPosition) <= .001 && !this.seeking) {
            if (playing) await this.play(); else this.apply(await this.command('pause'));
            return;
        }
        // Whole-file Desktop playback primes its playlist/DSP on Play. Streaming uses
        // a new source whose origin is the checkpoint; playing the zero-origin source
        // first would briefly restart the song before its replacement is ready.
        const primeHQPlayerFile = this.backend === 'hqplayer' && !this.buffer.streaming;
        if (this.backend === 'hqplayer' && this.buffer.streaming) {
            // Handoff restores volume/mute just before requesting its checkpoint. Their
            // queued controls must finish on the ready source before stream-reset retires it.
            const beforeControls = this.intent;
            await Promise.all([this.queue, this.streamingControls]);
            if (this.disposed || session !== this.session || beforeControls !== this.intent)
                throw new DOMException('Playback cancelled', 'AbortError');
        }
        if (playing && primeHQPlayerFile) await this.play();
        const intent = this.intent, revision = ++this.revision;
        // Metadata restoration can already have started a seek. This transaction replaces it
        // and must own seeking/seeked, or its cancelled setter leaves state ticks blocked.
        this.seeking = true; this.emit('seeking');
        try {
            const state = await this.command('seek', { position });
            if (this.disposed || session !== this.session || revision !== this.revision)
                throw new DOMException('Playback cancelled', 'AbortError');
            this.seeking = false; this.presentedTime = state.position; this.apply(state);
            this.emit('seeked'); this.emit('timeupdate');
            if (playing && !primeHQPlayerFile && intent === this.intent) await this.play();
        } catch (error) {
            if (revision === this.revision) { this.seeking = false; this.fail(error, 'seek'); }
            throw error;
        }
    }
    dispose(reason?: 'handoff') {
        // Disposal retires a deck; it is not a newer listener Pause/Seek request.
        const playback = this.playbackIntent, seek = this.seekIntent;
        this.disposed = true; this.cancel(reason); this.unsubscribe();
        this.playbackIntent = playback; this.seekIntent = seek;
    }
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
