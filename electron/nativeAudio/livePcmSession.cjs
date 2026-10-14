const net = require('node:net');
const { once } = require('node:events');
const { createStreamSession } = require('./streamSession.cjs');
const { audioError, errorCode, sourceLifecycleError } = require('./errors.cjs');
const { createHQPlayerExperimentDiagnostics } = require('./hqplayerSpotifyExperiment.cjs');
const { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef } = require('../debug/privatePreviewDiagnosticBus.cjs');
const { requireLivePcmTransport } = require('./livePcmFormat.cjs');

// Count sample categories only in an explicitly enabled private preview; PCM never reaches the journal.
function createPcmDiagnosticCounter({ session, backend, channels, clock = Date.now,
    enabled = isPreviewDiagnosticsEnabled, publish = publishPreviewDiagnostic } = {}) {
    let counts = null, closed = false, firstNonzeroReported = false;
    if (enabled()) {
        try { const time = clock(); if (Number.isFinite(time)) counts = { started: time, last: time, frames: 0, zeroSamples: 0, nonzeroSamples: 0, bytes: 0 }; } catch {}
    }
    const bound = value => Math.min(2 ** 42, value);
    function emit(phase, time) {
        publish('native.pcm', { sessionRef: previewSessionRef(session), backend, phase, frames: counts.frames,
            zeroSamples: counts.zeroSamples, nonzeroSamples: counts.nonzeroSamples, bytes: counts.bytes,
            elapsedMs: Math.max(0, Math.round(time - counts.started)) });
        counts.last = time;
    }
    return {
        observe(bytes) {
            if (closed || !enabled()) return;
            try {
                const time = clock(); if (!Number.isFinite(time)) return;
                counts ||= { started: time, last: time, frames: 0, zeroSamples: 0, nonzeroSamples: 0, bytes: 0 };
                let zero = 0;
                for (let offset = 0; offset + 4 <= bytes.length; offset += 4) if (bytes.readInt32LE(offset) === 0) zero++;
                counts.bytes = bound(counts.bytes + bytes.length);
                counts.frames = bound(counts.frames + bytes.length / (channels * 4));
                counts.zeroSamples = bound(counts.zeroSamples + zero);
                counts.nonzeroSamples = bound(counts.nonzeroSamples + bytes.length / 4 - zero);
                if (!firstNonzeroReported && counts.nonzeroSamples > 0) { firstNonzeroReported = true; emit('first-nonzero', time); }
                else if (time - counts.last >= 5000) emit('sample', time);
            } catch { /* Observability must never fail or delay the audio producer. */ }
        },
        finish() {
            if (closed) return; closed = true;
            if (!counts || !enabled()) return;
            try { emit('final', clock()); } catch { /* The sink is optional. */ }
        },
    };
}

const EXPIRED_SOURCE_CODES = new Set(['TRACK_NOT_CURRENT', 'STALE_SESSION', 'SUPERSEDED']);
const UNAVAILABLE_SOURCE_CODES = new Set(['APPLIANCE_UNAVAILABLE', 'CONTROL_TIMEOUT', 'CONTROL_FAILED', 'CONTROL_RESPONSE_TOO_LARGE',
    'CONTROL_REJECTED', 'CONTROL_PROTOCOL_INVALID', 'CONTROL_BUSY', 'AUTH_REQUIRED', 'DEVICE_INACTIVE', 'PLAYBACK_STATE_UNCONFIRMED',
    'SEEK_UNCONFIRMED', 'READER_ALREADY_USED', 'NOT_PREPARED', 'PCM_SOURCE_UNAVAILABLE', 'PCM_FORMAT_INVALID', 'PCM_BLOCK_INVALID',
    'PCM_DURATION_EXCEEDED', 'PCM_TRUNCATED', 'PCM_INTERRUPTED']);

// electron/nativeAudio/livePcmSession.cjs — bounded, main-owned PCM directly to the output pipe.
function createLivePcmSession({ source, experiment, connectPipe = name => net.createConnection({ path: `\\\\.\\pipe\\${name}`, allowHalfOpen: true }), ...options }) {
    let parked = null, lastState = null, closed = false, intent = 0, queueSamplePending = false, lastQueueSample = -Infinity;
    let retirement = null, outputReleased = false, closeTask = null, preparing = null;
    const parkedControls = new Map();
    const observations = experiment?.enabled && options.current?.backend === 'hqplayer'
        ? createHQPlayerExperimentDiagnostics({ current: options.current, source, settings: experiment }) : null;
    const verifiedLive = options.current?.backend === 'hqplayer' && !experiment?.enabled;
    const memorySource = { state: { complete: false, available: 0 }, downloaded: Promise.resolve() };
    async function decode({ signal, position, onFormat, preparationRevision, prebufferMs }) {
        // Completion and byte counts belong to this reader, not a previously ended generation.
        memorySource.state.complete = false; memorySource.state.available = 0;
        let socket;
        const pcmDiagnostic = createPcmDiagnosticCounter({ session: options.current?.id, backend: options.current?.backend, channels: source.channels });
        const abort = () => socket?.destroy();
        signal.addEventListener('abort', abort, { once: true });
        try {
            options.progress(options.current, 'source', { preparationRevision });
            const opened = await source.openReadable({ positionMs: Math.round(position * 1000), signal });
            signal.throwIfAborted();
            const assertReader = () => {
                if (typeof source.assertReader === 'function') source.assertReader(opened);
                else if (verifiedLive) throw audioError('FORMAT_UNSUPPORTED', 'Live PCM reader has no ownership');
                if (verifiedLive) requireLivePcmTransport(opened.transport, source);
            };
            assertReader();
            if (typeof opened.prepareOrigin === 'function') {
                const origin = await opened.prepareOrigin(); signal.throwIfAborted(); assertReader();
                if (origin?.kind !== 'confirmed-command-origin-estimate' || origin.positionMs !== opened.positionMs
                    || !Number.isSafeInteger(origin.observedPositionMs) || origin.observedPositionMs < 0
                    || origin.observedPositionMs >= source.durationMs || !Number.isSafeInteger(origin.observedAt) || origin.observedAt < 0)
                    throw audioError('SOURCE_UNAVAILABLE');
            }
            options.progress(options.current, 'connect', { preparationRevision });
            // Ordinary seek reports its observed paused checkpoint. Combined Play
            // waits above for a typed confirmed-command origin estimate, with the
            // independently observed later GET checkpoint kept separately.
            if (opened.positionMs !== undefined && !Number.isSafeInteger(opened.positionMs)) throw audioError('SOURCE_UNAVAILABLE');
            const origin = opened.positionMs === undefined ? position : opened.positionMs / 1000;
            if (!Number.isFinite(origin) || origin < 0 || origin >= source.durationMs / 1000) throw audioError('SOURCE_UNAVAILABLE');
            const pipe = await onFormat({ sampleRate: source.sampleRate, channels: source.channels, blockAlign: source.channels * 4, position: origin,
                ...(verifiedLive ? { livePcmReader: opened } : {}) });
            assertReader();
            if (isPreviewDiagnosticsEnabled()) publishPreviewDiagnostic('native.format', { sessionRef: previewSessionRef(options.current?.id),
                backend: options.current?.backend, outputSampleRate: source.sampleRate, outputBitsPerSample: 32, outputChannels: source.channels,
                outputFormat: 's32le', formatStage: 'prepared-pcm', preparedSource: true });
            signal.throwIfAborted();
            options.progress(options.current, 'buffer', { loaded: 0, total: prebufferMs, unit: 'milliseconds', preparationRevision });
            socket = connectPipe(pipe); socket.on('error', () => {});
            await once(socket, 'connect', { signal });
            for await (const bytes of opened.stream) {
                signal.throwIfAborted();
                assertReader();
                if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || bytes.length % (source.channels * 4)) throw audioError('DECODE_FAILED', 'Invalid live PCM frame');
                const writable = socket.write(bytes);
                pcmDiagnostic.observe(bytes); observations?.input(bytes.length);
                if (!writable) await once(socket, 'drain', { signal });
                memorySource.state.available += bytes.length;
            }
            signal.throwIfAborted();
            if (!memorySource.state.available) throw audioError('DECODE_FAILED', 'Live producer ended without PCM frames');
            memorySource.state.complete = true;
            socket.end(); await once(socket, 'close', { signal });
        } catch (error) {
            if (signal.aborted) throw audioError('CANCELLED');
            if (['FORMAT_LEASE_READBACK_MISMATCH', 'HELPER_RESTART_REQUIRED'].includes(error?.nativeCode)) throw sourceLifecycleError(error);
            // Preserve native output/driver errors. A named source-control failure
            // is diagnosed as a source failure, without returning private messages.
            if (EXPIRED_SOURCE_CODES.has(error?.code)) throw audioError('SOURCE_EXPIRED', `Live PCM source failed (${error.code})`);
            if (UNAVAILABLE_SOURCE_CODES.has(error?.code)) throw audioError('SOURCE_UNAVAILABLE', `Live PCM source failed (${error.code})`);
            if (error?.code && errorCode(error) === error.code) throw error;
            if (['Spotify: session-changed', 'Spotify: external-playback-change'].includes(error?.message))
                throw audioError('SOURCE_EXPIRED', 'Live PCM source session changed');
            if (error?.message === 'Spotify: request-cancelled') throw audioError('CANCELLED');
            // Spotify source errors already have a safe public projection; keep them
            // in the source domain instead of presenting a native device connection failure.
            if (['unavailable', 'auth-required', 'setup-required', 'unsupported', 'not-playable', 'invalid-response'].includes(error?.code))
                throw sourceLifecycleError(error);
            throw error;
        } finally { pcmDiagnostic.finish(); signal.removeEventListener('abort', abort); socket?.destroy(); }
    }
    const base = createStreamSession({ ...options, sourceFactory: () => memorySource, decode, freshFormatOnReset: true,
        retireAction: verifiedLive ? 'stream-retire' : 'pause',
        ...(observations ? { startupDelayMs: experiment.startupDelayMs,
            onBufferState: (...args) => observations.observe(...args) } : {}) });
    const assertIntent = own => { if (closed || own !== intent || options.current.abort.signal.aborted) throw audioError('CANCELLED'); };
    function pauseAtHeardCheckpoint() {
        // A drained end is not a valid source seek checkpoint. The source already
        // restored its route before EOF; keep the endpoint only for displayed state.
        if (memorySource.state.complete && lastState?.ended) return source.pause();
        const position = parked ?? lastState?.position;
        // Before the first output acknowledgement, the source already owns its
        // requested checkpoint. Absence of an output sample does not mean zero.
        return Number.isFinite(position) ? source.pause({ positionMs: Math.round(position * 1000) }) : source.pause();
    }
    async function pauseSource(own) {
        try { await pauseAtHeardCheckpoint(); }
        // Release can invalidate a remote pause while its response is still in flight.
        // Report that retired command as cancellation, preserving current failures.
        catch (error) {
            if (closed || options.current.abort.signal.aborted) throw audioError('CANCELLED');
            throw sourceLifecycleError(error);
        }
    }
    const savedState = state => {
        // Closing a live producer on pause looks like a short file to the output
        // helper. Its observed byte count must not replace the song's duration.
        state = { ...state, duration: source.durationMs / 1000, preparationRevision: base.getPreparationRevision() };
        if (parked === null) return state;
        const naturalEnd = memorySource.state.complete && state.ended === true;
        return { ...state, position: parked, playing: false, ended: naturalEnd, buffering: false,
            bufferedStart: parked, bufferedEnd: parked, producerComplete: naturalEnd };
    };
    // Once retirement starts, every later prepare waits for the actual stop acknowledgement.
    // The checkpoint is the native output snapshot; source position and accepted PCM are never a clock.
    function retireOutput(own) {
        if (retirement) return retirement;
        const work = (async () => {
            const stopping = base.suspend();
            const results = await Promise.allSettled([pauseSource(own), stopping]);
            try { await base.releaseOutput(); outputReleased = true; }
            catch (error) { results.push({ status: 'rejected', reason: error }); }
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        })();
        retirement = work;
        // Preserve a failed barrier until close/Stop explicitly retries cleanup.
        void work.then(() => { if (retirement === work) retirement = null; }, () => {});
        return work;
    }
    return {
        source: memorySource,
        async prepare(position = 0) {
            if (retirement) await retirement;
            if (closed) throw audioError('CANCELLED');
            lastState = savedState(await base.prepare(position)); outputReleased = false; return lastState;
        },
        async command(action, args = {}) {
            if (closed) throw audioError('CANCELLED');
            // The source accepts checkpoints before its duration, including a
            // playing drag to the progress bar's exact endpoint.
            if (action === 'seek') args = { ...args, position: Math.max(0, Math.min(args.position, source.durationMs / 1000 - 0.001)) };
            const own = ['pause', 'seek', 'play'].includes(action) ? ++intent : intent;
            if (action === 'pause') {
                if (retirement) { await retirement; assertIntent(own); return savedState(lastState); }
                if (preparing) { await retireOutput(own); assertIntent(own); return savedState(lastState); }
                if (parked !== null && outputReleased) return savedState(lastState);
                const naturalEnd = memorySource.state.complete && lastState?.ended;
                const state = await base.command('pause', args); assertIntent(own);
                lastState = naturalEnd ? { ...state, position: lastState.position, ended: true } : state; parked = lastState.position;
                if (Number.isFinite(state.hqplayerGainDb)) parkedControls.set('gain', { gainDb: state.hqplayerGainDb });
                await retireOutput(own); assertIntent(own);
                return savedState(lastState);
            }
            if (retirement) { await retirement; assertIntent(own); }
            if (action === 'seek' && (parked !== null || !lastState?.playing)) {
                if (!outputReleased) {
                    lastState = await base.command('pause'); assertIntent(own);
                    parked = lastState.position;
                    await retireOutput(own); assertIntent(own);
                }
                parked = args.position;
                lastState = { ...lastState, ended: false };
                await source.seek?.(Math.round(parked * 1000)); assertIntent(own);
                return savedState(lastState);
            }
            // A parked device owns no output. Gain/volume requests remain local until Play;
            // the renderer reapplies its current values after the fresh load.
            if (outputReleased && ['volume', 'replaygain', 'gain', 'status'].includes(action)) {
                if (action !== 'status') parkedControls.set(action, args);
                return savedState(lastState);
            }
            if (action === 'play' && parked !== null) {
                const position = memorySource.state.complete && lastState?.ended ? 0 : parked;
                const work = base.prepare(position, !outputReleased, outputReleased); preparing = work;
                let state;
                try { state = await work; } finally { if (preparing === work) preparing = null; }
                assertIntent(own);
                lastState = state; outputReleased = false; parked = null;
                for (const [control, values] of parkedControls) {
                    lastState = await base.command(control, values); assertIntent(own);
                }
                parkedControls.clear();
            }
            // Only this explicit currently-playing seek may retain initialized
            // capture. It retires the old source reader before base aborts it;
            // ordinary Pause, Stop and generic reader replacement still stop fully.
            let seeking;
            const beforeReplace = action === 'seek' && lastState?.playing && parked === null
                ? ({ position, playing }) => {
                    assertIntent(own);
                    if (playing) seeking = source.beginPlayingSeek?.({ positionMs: Math.round(position * 1000) });
                } : undefined;
            try {
                // Read the old output while its reader is still owned, then park
                // capture immediately before the decoder generation is replaced.
                const state = await base.command(action, args, beforeReplace); assertIntent(own); lastState = state;
                return savedState(lastState);
            } catch (error) { await seeking?.cancel?.(); throw error; }
        },
        observe(state) {
            if (!base.observe(state)) return false;
            Object.assign(state, savedState(state));
            lastState = state;
            // Component events describe decoded lead. Read the actual loopback queue separately,
            // at most once a second, and discard any reply that belongs to a replaced generation.
            if (observations && !closed && !options.current.abort.signal.aborted && isPreviewDiagnosticsEnabled() && state.playing && !queueSamplePending && Date.now() - lastQueueSample >= 1000) {
                const ownIntent = intent, ownGeneration = state.streamGeneration;
                queueSamplePending = true; lastQueueSample = Date.now();
                Promise.resolve().then(() => options.helper.request({ action: 'status', session: options.current.id })).then(status => {
                    if (!closed && !options.current.abort.signal.aborted && ownIntent === intent && status.streamGeneration === ownGeneration)
                        observations.observe('sample', status);
                }).catch(() => {}).finally(() => { queueSamplePending = false; });
            }
            return true;
        },
        async close({ retainSource = false } = {}) {
            if (closeTask) return closeTask;
            closed = true; ++intent;
            closeTask = (async () => {
                await retirement?.catch(() => {});
                const stopping = base.suspend();
                const restore = retainSource
                    ? pauseAtHeardCheckpoint()
                    : source.stop ? source.stop() : source.pause();
                const results = await Promise.allSettled([Promise.resolve(restore).catch(error => { throw sourceLifecycleError(error); }), stopping]);
                try { await base.close(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
                observations?.finish();
                const failure = results.find(result => result.status === 'rejected');
                if (failure) throw failure.reason;
            })();
            void closeTask.catch(() => { closeTask = null; });
            return closeTask;
        },
    };
}
module.exports = { createLivePcmSession, createPcmDiagnosticCounter };
