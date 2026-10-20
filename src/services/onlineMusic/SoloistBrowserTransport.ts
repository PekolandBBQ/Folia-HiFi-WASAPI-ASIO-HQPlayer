import { markProgrammaticPause } from '../playbackFade';
import { registerPlaybackProviderOutput } from '../playbackProviderOutput';
import { NativeAudioTransport } from '../nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioEvent, NativeAudioState } from '../../types/nativeAudio';

// src/services/onlineMusic/SoloistBrowserTransport.ts: browser Web Audio output with bounded PCM IPC.
export type SoloistBrowserRequest = { action: 'begin' | 'start' | 'position' | 'pull' | 'pause' | 'stop';
    session: string; url?: string; positionMs?: number; generation?: number };
export type SoloistBrowserBridge = { browserPcm(request: SoloistBrowserRequest): Promise<unknown> };
type Reply = { generation?: number; durationMs?: number; positionMs?: number; data?: Uint8Array; complete?: boolean;
    spotifyError?: { code: string; message: string } };

export function createSoloistBrowserApi(bridge: SoloistBrowserBridge, beforeOutputExit = () => {}): NativeAudioApi & { dispose(): void } {
    const listeners = new Set<(event: NativeAudioEvent) => void>();
    let state: NativeAudioState | null = null, source = '', generation = 0, revision = 0, origin = 0;
    let sentFrames = 0, consumedFrames = 0, complete = false, pumping = false, disposed = false;
    let context: AudioContext | null = null, node: AudioWorkletNode | null = null, gain: GainNode | null = null;
    let setup: Promise<void> | null = null;
    let pendingSeek: { playing: boolean } | null = null;
    const cancelled = () => new DOMException('Playback cancelled', 'AbortError');
    const emit = () => { if (state && !disposed) for (const listener of listeners) listener({ event: 'state', session: state.session, state: { ...state } }); };
    const snapshot = () => {
        if (!state) throw cancelled();
        return { ...state };
    };
    async function invoke(request: SoloistBrowserRequest): Promise<Reply> {
        const reply = await bridge.browserPcm(request) as Reply;
        if (reply?.spotifyError?.message === 'Spotify: request-cancelled') throw cancelled();
        if (reply?.spotifyError) throw Object.assign(new Error(reply.spotifyError.message), { code: reply.spotifyError.code });
        return reply;
    }
    function updateBuffer() {
        if (!state) return;
        state.position = origin + consumedFrames / 44100;
        state.bufferedStart = state.position; state.bufferedEnd = origin + sentFrames / 44100;
        state.producerComplete = complete; state.buffering = state.playing && consumedFrames >= sentFrames && !complete;
        if (state.playing && complete && consumedFrames >= sentFrames) { state.ended = true; state.playing = false; }
    }
    function reset(playing = false) {
        if (state) origin = state.position;
        ++revision; sentFrames = 0; consumedFrames = 0; complete = false; pumping = false;
        node?.port.postMessage({ type: 'reset', generation: revision, playing });
        if (state) { state.playing = playing; state.ended = false; updateBuffer(); }
    }
    async function pump() {
        if (pumping || !state?.playing || complete || disposed) return;
        pumping = true;
        const currentRevision = revision, session = state.session, producerGeneration = generation;
        try {
            // At most ~0.8 seconds, including bytes sent but not yet accepted by the worklet.
            while (state?.playing && currentRevision === revision && !complete && sentFrames - consumedFrames < 26460) {
                const result = await invoke({ action: 'pull', session, generation: producerGeneration });
                if (disposed || currentRevision !== revision) return;
                if (result.generation !== producerGeneration || !(result.data instanceof Uint8Array)
                    || result.data.byteLength > 65536 || result.data.byteLength % 8) throw new Error('Invalid browser PCM block');
                if (result.data.byteLength) {
                    const data = Uint8Array.from(result.data); sentFrames += data.byteLength / 8;
                    node!.port.postMessage({ type: 'block', generation: currentRevision, data }, [data.buffer]);
                }
                if (result.complete) { complete = true; node!.port.postMessage({ type: 'complete', generation: currentRevision }); }
                if (!result.data.byteLength && !result.complete) throw new Error('Empty browser PCM block');
                updateBuffer(); emit();
            }
        } catch (error) {
            if (!disposed && currentRevision === revision && state) {
                state.playing = false; node?.port.postMessage({ type: 'play', generation: revision, playing: false });
                for (const listener of listeners) listener({ event: 'error', session, errorCode: (error as { code?: string }).code || 'SOURCE_UNAVAILABLE' });
            }
        } finally { if (currentRevision === revision) pumping = false; }
    }
    async function initialize() {
        if (setup) return setup;
        setup = (async () => {
            context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
            if (context.sampleRate !== 44100) throw new Error('Unsupported browser PCM sample rate');
            await context.audioWorklet.addModule(new URL('./soloistPcmWorklet.js', import.meta.url).href);
            if (disposed) { await context.close(); throw cancelled(); }
            node = new AudioWorkletNode(context, 'folia-soloist-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
            gain = context.createGain(); node.connect(gain).connect(context.destination);
            node.port.onmessage = ({ data }) => {
                if (disposed || data.generation !== revision || !state) return;
                if (data.type === 'error') {
                    state.playing = false;
                    for (const listener of listeners) listener({ event: 'error', session: state.session, errorCode: 'SOURCE_UNAVAILABLE' });
                    return;
                }
                if (data.type !== 'state' || !Number.isSafeInteger(data.frames) || data.frames < consumedFrames || data.frames > sentFrames) return;
                consumedFrames = data.frames; updateBuffer();
                if (state.ended) node!.port.postMessage({ type: 'play', generation: revision, playing: false });
                emit(); void pump();
            };
            node.port.postMessage({ type: 'reset', generation: revision, playing: false });
        })();
        return setup;
    }
    function syncGain() {
        if (!gain || !state) return;
        gain.gain.value = Math.min(16, Math.max(0, (state.volume ?? 1) * (state.replayGain ?? 1)));
        state.effectiveGain = gain.gain.value;
    }
    async function play() {
        if (!state) throw cancelled();
        const currentRevision = revision, session = state.session;
        await initialize(); await context!.resume();
        if (disposed || currentRevision !== revision || state?.session !== session) throw cancelled();
        // Only an initialized AudioContext reports engine rate/format; this is not the system DAC rate.
        state.sampleRate = context!.sampleRate; state.outputRateReported = true;
        state.latency = context!.baseLatency; state.outputFormat = 'Web Audio float32';
        if (state.playing) return snapshot();
        const started = await invoke({ action: 'start', session, positionMs: state.ended ? 0
            : Math.min(Math.floor(state.position * 1000), Math.floor(state.duration * 1000) - 1) });
        if (disposed || currentRevision !== revision || state?.session !== session) throw cancelled();
        if (!Number.isSafeInteger(started.positionMs) || !Number.isSafeInteger(started.generation)) throw new Error('Invalid browser PCM origin');
        generation = started.generation!; origin = started.positionMs! / 1000; state.position = origin; reset(true); syncGain();
        void pump(); return snapshot();
    }
    const unregisterOutput = registerPlaybackProviderOutput('spotify', async () => {
        if (disposed || !state) return;
        const session = state.session;
        if (state.playing) beforeOutputExit();
        pendingSeek = null; reset(false); emit();
        // Stop the worklet's actual output before the main process restores its route.
        await context?.suspend();
        // Main owns source quiescence and final recovery. Keep this renderer
        // receipt limited to output, so a revoked reader cannot block that recovery.
        if (state?.session === session) state = null;
    });
    return {
        supported: true,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async request(input) {
            if (disposed) throw cancelled();
            if (input.action === 'begin') {
                pendingSeek = null; reset(false); source = input.url || '';
                const requestRevision = revision;
                const opened = await invoke({ action: 'begin', session: input.session!, url: source });
                if (disposed || requestRevision !== revision) throw cancelled();
                if (!Number.isSafeInteger(opened.durationMs) || opened.durationMs! <= 0) throw new Error('Invalid browser PCM metadata');
                origin = 0; generation = opened.generation!;
                const metadata = input.sourceMetadata;
                state = { session: input.session!, position: 0, duration: opened.durationMs! / 1000, playing: false, ended: false,
                    sampleRate: 0, channels: 2, latency: context?.baseLatency ?? 0, backend: 'browser', deviceId: '',
                    streaming: true, buffering: false, bufferedStart: 0, bufferedEnd: 0, producerComplete: false,
                    sourceEncodingVerified: false, preparedSource: true, requestedQuality: metadata?.requestedQuality,
                    ...(metadata?.sourceOrigin ? { sourceOrigin: metadata.sourceOrigin } : {}),
                    preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 },
                    volume: 1, replayGain: 1, outputRateReported: false, outputMode: 'PCM' };
                return snapshot();
            }
            if (!state || input.session !== state.session) throw cancelled();
            if (input.action === 'finish' || input.action === 'status') return snapshot();
            if (input.action === 'volume' || input.action === 'replaygain') {
                if (input.action === 'volume') state.volume = Math.max(0, Math.min(1, input.volume ?? 1));
                else state.replayGain = Math.max(0, Math.min(16, input.gain ?? 1));
                syncGain(); return snapshot();
            }
            if (input.action === 'play') { pendingSeek = null; return play(); }
            if (input.action === 'pause' || input.action === 'stop') {
                const session = state.session; pendingSeek = null; reset(false); emit();
                await invoke({ action: input.action, session });
                return snapshot();
            }
            if (input.action === 'seek') {
                const session = state.session;
                // A replaced seek inherits playback intent, not the temporary pause while its predecessor positions.
                const seeking = { playing: pendingSeek?.playing ?? state.playing }; pendingSeek = seeking;
                reset(false);
                const currentRevision = revision;
                try {
                    const positioned = await invoke({ action: 'position', session, positionMs: Math.max(0,
                        Math.min(Math.floor((input.position ?? 0) * 1000), Math.floor(state.duration * 1000) - 1)) });
                    if (disposed || currentRevision !== revision || session !== state.session) throw cancelled();
                    if (!Number.isSafeInteger(positioned.positionMs)) throw new Error('Invalid browser PCM origin');
                    origin = positioned.positionMs! / 1000; updateBuffer();
                    return seeking.playing ? await play() : snapshot();
                } finally { if (pendingSeek === seeking) pendingSeek = null; }
            }
            throw new Error('Unsupported browser PCM operation');
        },
        dispose() { if (disposed) return; unregisterOutput(); disposed = true; pendingSeek = null; reset(false); listeners.clear(); node?.disconnect(); gain?.disconnect(); void context?.close(); },
    };
}

// Reuse Folia's media-event and output-checkpoint adapter; this output itself is Web Audio.
export class SoloistBrowserTransport extends NativeAudioTransport {
    private browserApi: ReturnType<typeof createSoloistBrowserApi>;
    constructor(bridge: SoloistBrowserBridge) {
        let owner: SoloistBrowserTransport | undefined;
        const api = createSoloistBrowserApi(bridge, () => { if (owner) markProgrammaticPause(owner.asMediaElement()); });
        super(api, 'browser', '', 'compatibility', async () => null); this.browserApi = api; owner = this;
    }
    override dispose() { super.dispose(); this.browserApi.dispose(); }
}
