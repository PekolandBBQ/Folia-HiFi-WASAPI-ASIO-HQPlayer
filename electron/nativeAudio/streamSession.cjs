const { validateLivePcmPrebufferMs } = require('./livePcmPrebuffer.cjs');
const { randomUUID } = require('node:crypto');
const { createProgressiveSource } = require('./progressiveSource.cjs');
const { decodeStream } = require('./streamDecoder.cjs');
const { audioError } = require('./errors.cjs');

// Owns one progressive source and replaceable decoders; seeks never let old PCM enter a new pipe.
function createStreamSession({ current, helper, executable, fetchImpl, progress, assertCurrent, onError,
    sourceFactory = createProgressiveSource, decode = decodeStream, prebufferSeconds = 0.35, startupDelayMs = 0, refillProgressSeconds, getPrebufferMs, onBufferState, freshFormatOnReset = false, retireAction = 'stream-retire', releaseOutput, openOutput = request => helper.request(request) }) {
    let decoder = null, revision = 0, seekIntent = 0, seekPending = false, generation = 0, generationRevision = 0, format = null, ready = false, ended = false, playIntent = null;
    let appliedPrebufferSeconds = prebufferSeconds;
    let waitingForBuffer = false, lastDownloadProgress, pendingSeek = null, playIntentRevision = 0;
    const report = (stage, values = {}, preparationRevision = revision) => {
        if (preparationRevision === revision) progress(current, stage, { ...values, preparationRevision });
    };
    const source = sourceFactory({ url: current.downloadUrl || current.remoteUrl, file: current.input, signal: current.abort.signal, fetchImpl,
        onProgress: values => {
            if (values.contentType) current.sourceMimeType = values.contentType;
            const { contentType, ...publicValues } = values;
            lastDownloadProgress = publicValues;
            if (waitingForBuffer && !values.complete) return;
            if (!values.complete || ready) report('download', publicValues);
            else report('decode');
        } });
    source.downloaded.catch(error => { if (ready && !current.abort.signal.aborted) onError(error); });
    const observeBuffer = (...args) => { try { onBufferState?.(...args); } catch { /* Diagnostics cannot interrupt playback. */ } };
    const request = async (action, args = {}) => {
        const preparationRevision = revision;
        const state = await helper.request({ action, session: current.id, ...args });
        if (action === 'play') observeBuffer('playing', state);
        return { ...state, preparationRevision, ...(getPrebufferMs ? { livePcmPrebufferMs: appliedPrebufferSeconds * 1000 } : {}) };
    };
    const pause = (ms, signal) => new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(audioError('CANCELLED')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    function prepare(position = 0, reset = false, preserveSettings = false) {
        // Freeze this preparation before any await; a later setting/intent cannot resize its buffer.
        const targetSeconds = getPrebufferMs ? validateLivePcmPrebufferMs(getPrebufferMs()) / 1000 : prebufferSeconds;
        appliedPrebufferSeconds = targetSeconds;
        const ownRevision = ++revision;
        current.preparationStartedAt = Date.now();
        const previous = decoder, controller = new AbortController(), signal = controller.signal;
        previous?.controller.abort();
        const work = { controller, preparing: null, decoding: null }; decoder = work;
        // Capture this generation's controller; an old listener must never abort its replacement.
        const abort = () => controller.abort(); current.abort.signal.addEventListener('abort', abort, { once: true });
        if (current.abort.signal.aborted) abort();
        work.preparing = (async () => {
        // A cancelled reset may still own an in-flight RPC. Let it finish before opening the new pipe.
        await previous?.preparing?.catch(() => {}); await previous?.decoding?.catch(() => {});
        assertCurrent(current); signal.throwIfAborted();
        if (ownRevision !== revision) throw audioError('CANCELLED');
        let pipeName = `folia-audio-${randomUUID()}`;
        let opened = false, completed = false, failure, bufferReadyAt = null, outputReadyAt = null, lastBufferProgress = -Infinity;
        const preparationStarted = Date.now();
        observeBuffer('configured', {}, { prebufferMs: targetSeconds * 1000 });
        const open = async pcm => {
            assertCurrent(current); signal.throwIfAborted();
            if (ownRevision !== revision) throw audioError('CANCELLED');
            if (format && (pcm.sampleRate !== format.sampleRate || pcm.channels !== format.channels)) throw audioError('FORMAT_UNSUPPORTED', 'Audio format changed during seek');
            current.sourceInfo = await require('./sourceInfo.cjs').readOriginalSourceInfo(current);
            assertCurrent(current); signal.throwIfAborted();
            if (ownRevision !== revision) throw audioError('CANCELLED');
            format = pcm; current.loadRequested = true;
            const openedState = await openOutput({ action: reset ? 'stream-reset' : 'stream-load', session: current.id, pipeName, position: pcm.position ?? position,
                sampleRate: pcm.sampleRate, channels: pcm.channels, duration: current.durationHint || 0,
                ...(preserveSettings && current.backend === 'hqplayer' ? { defaults: undefined } : {}),
                ...(pcm.livePcmReader ? { livePcmReader: pcm.livePcmReader } : {}),
                backend: current.backend, deviceId: current.deviceId, processingMode: current.processingMode });
            assertCurrent(current); signal.throwIfAborted();
            if (ownRevision !== revision) throw audioError('CANCELLED');
            if (openedState.pipeName) pipeName = openedState.pipeName;
            generation = openedState.streamGeneration || 0; generationRevision = ownRevision;
            opened = true; return pipeName;
        };
        // Reset the old device immediately, even if the new decoder needs time to reach the target.
        if (reset && format) {
            // Live readers carry per-intent authority. Retire audible old output now,
            // then obtain a fresh reader after remote pause/seek before resetting it.
            if (freshFormatOnReset) await request(retireAction);
            else await open(format);
        }
        work.decoding = decode({ executable, source, signal, position, compatibilityMode: current.compatibilityMode, preparationRevision: ownRevision, prebufferMs: targetSeconds * 1000,
            onFormat: async pcm => opened ? pipeName : open(pcm) }).then(() => {
            completed = true;
        }).catch(error => {
            if (signal.aborted || ownRevision !== revision || current.abort.signal.aborted) return;
            failure = error;
            if (ready) onError(error);
        }).finally(() => current.abort.signal.removeEventListener('abort', abort));
        while (true) {
            assertCurrent(current); signal.throwIfAborted();
            if (failure) throw failure;
            if (ownRevision !== revision) throw audioError('CANCELLED');
            if (opened) {
                const state = await request('status');
                assertCurrent(current); signal.throwIfAborted();
                if (ownRevision !== revision) throw audioError('CANCELLED');
                // A failed producer closes its pipe while this RPC is pending. Its
                // resulting device EOF must never turn the failed load into ready.
                if (failure) throw failure;
                if (state.errorCode) throw audioError(state.errorCode);
                const buffered = Math.max(0, (state.bufferedEnd || 0) - (state.position || 0));
                if (state.ready !== false) outputReadyAt ??= Date.now();
                const sufficientlyBuffered = state.ready !== false && (buffered >= targetSeconds
                    || ((completed || state.producerComplete) && (buffered > 0 || state.ended)));
                if (!sufficientlyBuffered) bufferReadyAt = null;
                else bufferReadyAt ??= Date.now();
                const startupWaitMs = bufferReadyAt === null ? 0 : Math.max(0, Date.now() - bufferReadyAt);
                const timing = { prebufferWaitMs: Math.max(0, (bufferReadyAt ?? Date.now()) - preparationStarted), startupWaitMs,
                    outputReadyWaitMs: Math.max(0, (outputReadyAt ?? Date.now()) - preparationStarted) };
                observeBuffer(sufficientlyBuffered ? 'delay' : 'waiting', state, timing);
                if (onBufferState && Date.now() - lastBufferProgress >= 100) { lastBufferProgress = Date.now(); report('buffer', { loaded: Math.min(targetSeconds * 1000, Math.round(buffered * 1000)),
                    total: targetSeconds * 1000, unit: 'milliseconds',
                    ...(sufficientlyBuffered && startupWaitMs < startupDelayMs ? { startupDelayMs, startupElapsedMs: Math.min(startupDelayMs, startupWaitMs) } : {}) }, ownRevision); }
                // Keep pumping PCM while waiting. This elapsed-time gate never waits for a paused
                // consumer to drain a full queue, and the existing generation signal cancels it.
                if (sufficientlyBuffered && startupWaitMs >= startupDelayMs) {
                    current.sourceInfo = await require('./sourceInfo.cjs').readOriginalSourceInfo(current);
                    assertCurrent(current); signal.throwIfAborted();
                    if (ownRevision !== revision) throw audioError('CANCELLED');
                    if (failure) throw failure;
                    // Initial failures remain recoverable until every readiness await has settled.
                    ready = true; ended = false;
                    observeBuffer('ready', state, timing);
                    if (source.state.complete) report('download', { loaded: source.state.available, total: source.state.available, complete: true }, ownRevision);
                    return { ...state, ...current.sourceInfo, preparationRevision: ownRevision, ...(getPrebufferMs ? { livePcmPrebufferMs: targetSeconds * 1000 } : {}) };
                }
            } else if (completed) throw audioError('DECODE_FAILED', 'No decodable audio stream');
            await pause(25, signal);
        }
        })().catch(async error => {
            const cancelled = signal.aborted || ownRevision !== revision || current.abort.signal.aborted;
            // Failed output readiness owns no playable generation. Retire its producer
            // before rejecting, without cancelling the reusable session-owned source.
            controller.abort(); await work.decoding?.catch(() => {});
            if (cancelled || ownRevision !== revision || current.abort.signal.aborted) throw audioError('CANCELLED');
            throw error;
        }).finally(() => { if (!work.decoding) current.abort.signal.removeEventListener('abort', abort); });
        return work.preparing;
    }
    async function command(action, args, beforeReplace) {
        if (action === 'play') { playIntent = true; ++playIntentRevision; }
        if (action === 'pause') { playIntent = false; ++playIntentRevision; }
        if (action === 'seek' || (action === 'play' && ended && !seekPending)) {
            const wasSeeking = seekPending, ownIntent = ++seekIntent; seekPending = true;
            const intentAtStart = playIntentRevision, previousSeek = pendingSeek;
            // Concurrent seeks share the last still-owned output snapshot. It is
            // timing data only; replacement PCM keeps its independent reader proof.
            const work = { intent: ownIntent, task: null, before: null,
                snapshot: previousSeek?.before ? Promise.resolve(previousSeek.before) : request('status') }; pendingSeek = work;
            // Own the whole replacement before its first status RPC: the old decoder
            // may still be ready while that RPC waits, but it is no longer playable.
            work.task = (async () => {
            try {
            const before = await work.snapshot;
            if (ownIntent !== seekIntent) throw audioError('CANCELLED');
            work.before = before;
            if (action === 'seek' && before.ended && !wasSeeking && intentAtStart === playIntentRevision) playIntent = false;
            if (playIntent === null) playIntent = before.playing;
            const position = action === 'play' ? 0 : Math.max(0, Math.min(before.duration > 0 ? before.duration : args.position, args.position));
            report('buffer', { loaded: 0, total: getPrebufferMs ? validateLivePcmPrebufferMs(getPrebufferMs()) : prebufferSeconds * 1000, unit: 'milliseconds' });
            assertCurrent(current);
            beforeReplace?.({ position, playing: playIntent });
            const state = await prepare(position, true);
            if (ownIntent !== seekIntent) throw audioError('CANCELLED');
            if (playIntent) return request('play', { streamGeneration: state.streamGeneration });
            return state;
            } finally { if (ownIntent === seekIntent) { seekPending = false; pendingSeek = null; } }
            })();
            return work.task;
        }
        if (action === 'play' && pendingSeek) {
            const work = pendingSeek, ownPlayIntent = playIntentRevision;
            const state = await work.task;
            assertCurrent(current);
            if (work.intent !== seekIntent || ownPlayIntent !== playIntentRevision || !playIntent) throw audioError('CANCELLED');
            // The replacement already applied the latest play intent once it had
            // PCM. Do not send a second play, or a play for a superseded generation.
            return state;
        }
        const state = await request(action, args);
        if (state.ended) ended = true;
        return state;
    }
    return { source, prepare, command, getPreparationRevision: () => revision, async releaseOutput() {
            // Release the driver through its existing stop contract. A later resume uses stream-load.
            await (releaseOutput ? releaseOutput() : request('stop'));
            ready = false;
        }, async suspend() {
            // Live producers must stop when the device pauses; their PCM is not a seekable cache.
            ++revision; ++seekIntent; seekPending = false; pendingSeek = null;
            const closing = decoder; closing?.controller.abort();
            await closing?.preparing?.catch(() => {}); await closing?.decoding?.catch(() => {});
            if (decoder === closing) decoder = null;
        }, async close() {
            ++revision; ++seekIntent; seekPending = false; pendingSeek = null; const closing = decoder; closing?.controller.abort();
            await closing?.preparing?.catch(() => {}); await closing?.decoding?.catch(() => {});
            if (decoder === closing) decoder = null;
            await helper.close?.(); await source.downloaded.catch(() => {});
        },
        observe(state) {
            // A failed or cancelled producer can still receive its pipe's final EOF.
            // That retired output must never advance the queue as a natural end.
            if (current.abort.signal.aborted || decoder?.controller.signal.aborted) return false;
            if (generationRevision !== revision) return false;
            if (state.streaming && state.streamGeneration !== undefined && state.streamGeneration !== generation) return false;
            state.preparationRevision = revision;
            if (getPrebufferMs) state.livePcmPrebufferMs = appliedPrebufferSeconds * 1000;
            // Reset/seek can overlap the previous generation's final event before the new
            // pipe response arrives. Only a steady current EOF clears the listener's play intent.
            if (!seekPending) { ended = state.ended; if (state.ended) playIntent = false; }
            const waiting = ready && state.buffering && state.playing;
            if (waiting) report('buffer', { loaded: Math.max(0, state.bufferedEnd - state.position) * 1000, total: (refillProgressSeconds ?? appliedPrebufferSeconds) * 1000, unit: 'milliseconds' });
            else if (waitingForBuffer && lastDownloadProgress) report('download', lastDownloadProgress);
            waitingForBuffer = waiting;
            observeBuffer(waiting ? 'buffering' : 'sample', state);
            return true;
        } };
}
module.exports = { createStreamSession };
