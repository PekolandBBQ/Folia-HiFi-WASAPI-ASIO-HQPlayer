const { audioError } = require('./errors.cjs');
const { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef } = require('../debug/privatePreviewDiagnosticBus.cjs');

// hqplayerSpotifyExperiment.cjs — bounded, session-owned settings and value-only experiment observations.
const DEFAULTS = Object.freeze({ enabled: false, prebufferMs: 350, startupDelayMs: 0 });
function validateHQPlayerSpotifyExperiment(value) {
    if (value === undefined) return { ...DEFAULTS };
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
        || !Number.isInteger(value.prebufferMs) || value.prebufferMs < 100 || value.prebufferMs > 2000
        || !Number.isInteger(value.startupDelayMs) || value.startupDelayMs < 0 || value.startupDelayMs > 1000)
        throw audioError('INVALID_REQUEST', 'Invalid Spotify HQPlayer experiment settings');
    return { enabled: value.enabled, prebufferMs: value.prebufferMs, startupDelayMs: value.startupDelayMs };
}

// Never inspect PCM samples here. Queue depth and estimated decoded lead are separate measurements;
// Pipe input timing includes downstream backpressure, not just network delivery.
// Buffering transitions are not proof of a hardware underrun or of the reported noise's cause.
function createHQPlayerExperimentDiagnostics({ current, source, settings, clock = Date.now,
    enabled = isPreviewDiagnosticsEnabled, publish = publishPreviewDiagnostic } = {}) {
    let appliedPrebufferMs = settings.prebufferMs;
    let started = clock(), lastInput = null, bytes = 0, maxInputGapMs = 0, bufferingEvents = 0, wasBuffering = false;
    let lastPublished = -Infinity, timing = {}, lastState = {}, generation = 0, closed = false, lastQueue = null;
    const elapsed = time => Math.max(0, Math.round(time - started));
    function emit(phase, force = false) {
        if (closed || !enabled()) return;
        const time = clock();
        if (!force && time - lastPublished < 1000) return;
        const duration = elapsed(time), gap = lastInput === null ? maxInputGapMs : Math.max(maxInputGapMs, time - lastInput);
        publish('native.hq-experiment', { sessionRef: previewSessionRef(current.id), backend: 'hqplayer', phase, generation,
            enabled: true, prebufferMs: appliedPrebufferMs, startupDelayMs: settings.startupDelayMs,
            elapsedMs: duration, prebufferWaitMs: timing.prebufferWaitMs, startupWaitMs: timing.startupWaitMs,
            componentReady: typeof lastState.ready === 'boolean' ? lastState.ready : undefined, outputReadyWaitMs: timing.outputReadyWaitMs,
            estimatedBufferedMs: Number.isFinite(lastState.bufferedEnd) && Number.isFinite(lastState.position)
                ? Math.max(0, Math.round((lastState.bufferedEnd - lastState.position) * 1000)) : undefined,
            queueDepthMs: lastQueue?.depthMs, queueSampleAgeMs: lastQueue ? Math.max(0, Math.round(time - lastQueue.time)) : undefined,
            bufferCapacityBytes: lastState.bufferCapacityBytes, buffering: typeof lastState.buffering === 'boolean' ? lastState.buffering : undefined, bufferingEvents,
            inputBytes: bytes, pipeInputBytesPerSecond: duration > 0 ? Math.round(bytes * 1000 / duration) : 0,
            pipeInputMaxGapMs: Math.max(0, Math.round(gap)), sampleRate: source.sampleRate, channels: source.channels,
            bitsPerSample: 32, pcmFormat: 's32le' });
        lastPublished = time;
    }
    return {
        input(length) {
            if (closed || !enabled()) return;
            const time = clock();
            if (lastInput !== null) maxInputGapMs = Math.max(maxInputGapMs, time - lastInput);
            lastInput = time; bytes = Math.min(2 ** 42, bytes + length);
        },
        observe(phase, state = {}, values = {}) {
            if (closed) return;
            if (phase === 'configured') {
                if (Number.isInteger(values.prebufferMs)) appliedPrebufferMs = values.prebufferMs;
                started = clock(); lastInput = null; bytes = 0; maxInputGapMs = 0; bufferingEvents = 0;
                wasBuffering = false; timing = {}; lastState = {}; lastQueue = null; ++generation;
            } else {
                lastState = state; timing = { ...timing, ...values };
                if (Number.isFinite(state.streamQueuedSeconds)) lastQueue = { time: clock(), depthMs: Math.round(state.streamQueuedSeconds * 1000) };
                const buffering = Boolean(state.buffering && state.playing);
                if (buffering && !wasBuffering) ++bufferingEvents;
                wasBuffering = buffering;
            }
            emit(phase, ['configured', 'ready', 'playing'].includes(phase));
        },
        finish() { if (closed) return; emit('final', true); closed = true; },
    };
}
module.exports = { DEFAULTS, validateHQPlayerSpotifyExperiment, createHQPlayerExperimentDiagnostics };
