const { audioError } = require('./errors.cjs');
const { requireLivePcmTransport } = require('./livePcmFormat.cjs');

// hqplayerStreamAdapter.cjs — maps the shared progressive decoder contract to the independently optional HQ component.
function createHQPlayerStreamAdapter({ hqplayer, current }) {
    let streamGeneration, revision = 0, lastState = null, liveReader, readerRetired = false, pendingOutput;
    const verifiedLive = Boolean(current.livePcmSource && !current.hqplayerSpotifyExperiment?.enabled);
    function assertReader(reader) {
        if (!verifiedLive) return;
        if (typeof current.livePcmSource.assertReader !== 'function') throw audioError('FORMAT_UNSUPPORTED', 'Live PCM reader has no ownership');
        current.livePcmSource.assertReader(reader);
        requireLivePcmTransport(reader?.transport);
    }
    const assertSession = request => {
        if ((current.abort?.signal.aborted && request.action !== 'stop') || request.session !== current.id) throw audioError('CANCELLED');
    };
    function nativeState(status) {
        if (status.errorCode) throw audioError(status.errorCode);
        const state = status.state || lastState || {};
        const position = Math.max(0, Number(state.position ?? status.position0) || 0);
        // PCM may already be queued while HQPlayer is launching; shared readiness waits for both conditions.
        const decodedEnd = Number.isFinite(status.decodedSeconds) ? (status.position0 || 0) + status.decodedSeconds
            : Number.isFinite(state.bufferedEnd) ? state.bufferedEnd : position + Math.max(0, Number(status.bufferedSeconds) || 0);
        const bufferedSeconds = status.ready === false ? 0 : Math.max(0, decodedEnd - position);
        const result = { ...state, session: current.id, backend: 'hqplayer', deviceId: 'hqplayer-local',
            streaming: true, streamGeneration: status.generation ?? streamGeneration,
            ready: status.ready !== false, producerComplete: Boolean(status.producerComplete),
            position, duration: Math.max(0, Number(state.duration ?? status.durationHint) || 0),
            playing: Boolean(state.playing), ended: Boolean(state.ended), buffering: Boolean(state.buffering),
            bufferedStart: position, bufferedEnd: position + bufferedSeconds,
            decodedFrames: status.decodedFrames, bufferCapacityBytes: status.bufferCapacityBytes,
            streamQueuedSeconds: status.bufferedSeconds,
            ...(status.pipeName ? { pipeName: status.pipeName.replace(/^\\\\\.\\pipe\\/, '') } : {}) };
        lastState = result; return result;
    }
    function spec(request) {
        const pipeName = request.pipeName;
        if (typeof pipeName !== 'string' || !/^folia-audio-[0-9a-f-]{36}$/i.test(pipeName)) throw audioError('INVALID_REQUEST', 'Invalid private decoder pipe name');
        if (verifiedLive) { assertReader(request.livePcmReader); requireLivePcmTransport(request.livePcmReader.transport, request); }
        return { session: current.id, sourceKind: current.livePcmSource ? 'spotify-live' : 'finite', sampleRate: request.sampleRate, channels: request.channels, bits32: true,
            ...(verifiedLive ? { transport: request.livePcmReader.transport } : {}),
            pipeName: `\\\\.\\pipe\\${pipeName}`, position0: request.position || 0, durationHint: request.duration ?? current.durationHint ?? 0,
            gainDb: request.hqplayerGainDb ?? (request.action === 'stream-reset' ? undefined : current.hqplayerGainDb), trackKey: request.trackKey ?? current.trackKey,
            // A seek or DSP restart keeps the settings already applied to this song.
            defaults: Object.hasOwn(request, 'defaults') ? request.defaults : messageDefaults(request.action),
            ...(verifiedLive ? {} : {
                sourceSampleRate: request.sourceSampleRate ?? current.sourceInfo?.sourceSampleRate ?? request.sampleRate,
                sourceBitsPerSample: request.sourceBitsPerSample ?? current.sourceInfo?.sourceBitsPerSample }) };
    }
    function messageDefaults(action) { return action === 'stream-reset' ? undefined : current.hqplayerDefaults; }
    async function request(message) {
        assertSession(message);
        if (['stream-load', 'stream-reset'].includes(message.action)) {
            const ownRevision = ++revision, settings = spec(message);
            pendingOutput = ownRevision;
            try {
            const connectionError = await current.connection;
            if (connectionError) throw connectionError;
            assertSession(message); if (ownRevision !== revision) throw audioError('CANCELLED');
            assertReader(message.livePcmReader);
            const result = message.action === 'stream-reset'
                ? await hqplayer.streamReset({ ...settings, generation: streamGeneration }) : await hqplayer.streamPrepare(settings, {
                    allowUnverifiedRaw: Boolean(current.livePcmSource && current.hqplayerSpotifyExperiment?.enabled) });
            assertSession(message); if (ownRevision !== revision) throw audioError('CANCELLED');
            assertReader(message.livePcmReader);
            liveReader = message.livePcmReader; readerRetired = false;
            streamGeneration = result.generation; lastState = null; return nativeState(result);
            } catch (error) {
                // The component may have opened a new output before this reader
                // was revoked. Retire it without closing a newer adapter revision.
                if (verifiedLive && ownRevision === revision) await hqplayer.streamClose(current.id).catch(() => {});
                throw error;
            } finally { if (pendingOutput === ownRevision) pendingOutput = null; }
        }
        if (message.action === 'status' || message.action === 'stream-status') {
            const ownRevision = revision;
            if (!readerRetired) assertReader(liveReader);
            const result = await hqplayer.streamStatus(current.id, streamGeneration);
            assertSession(message); if (ownRevision !== revision) throw audioError('CANCELLED');
            if (!readerRetired) assertReader(liveReader); return nativeState(result);
        }
        if (message.action === 'stream-retire' && verifiedLive) {
            // Decoder cancellation has already revoked the old reader. Pause its
            // output without using that revoked reader to authorize another stream.
            const ownRevision = ++revision; liveReader = null; readerRetired = true;
            await hqplayer.command(current.id, 'pause');
            assertSession(message); if (ownRevision !== revision) throw audioError('CANCELLED');
            return { ok: true };
        }
        if (message.action === 'stop') {
            ++revision; liveReader = null; await hqplayer.streamClose(current.id, pendingOutput ? undefined : streamGeneration); lastState = null; return { ok: true };
        }
        if (!['play', 'pause', 'volume', 'replaygain', 'gain'].includes(message.action)) throw audioError('INVALID_REQUEST');
        const value = message.action === 'volume' ? message.volume : message.action === 'replaygain' ? message.gain
            : message.action === 'gain' ? message.gainDb ?? message.gain : undefined;
        const ownRevision = revision;
        if (message.action === 'play' || !readerRetired) assertReader(liveReader);
        const result = await hqplayer.command(current.id, message.action, value); assertSession(message);
        if (ownRevision !== revision) throw audioError('CANCELLED');
        if (message.action === 'play' || !readerRetired) assertReader(liveReader);
        const status = await hqplayer.streamStatus(current.id, streamGeneration); assertSession(message);
        if (ownRevision !== revision) throw audioError('CANCELLED');
        if (message.action === 'play' || !readerRetired) assertReader(liveReader);
        const state = nativeState({ ...status, state: { ...status.state, ...result } });
        // Pause retires PCM ownership, while the silent output session still owns
        // volume/gain controls and status until a fresh reader resets it on resume.
        if (verifiedLive && message.action === 'pause') { liveReader = null; readerRetired = true; }
        return state;
    }
    async function close() { ++revision; liveReader = null; await hqplayer.streamClose(current.id, pendingOutput ? undefined : streamGeneration); lastState = null; }
    return { request, close, dispose: close, supportsStreaming: () => current.livePcmSource
        ? hqplayer.supportsStreaming({ sourceKind: 'spotify-live', allowUnverifiedRaw: current.hqplayerSpotifyExperiment?.enabled === true })
        : hqplayer.supportsStreaming() };
}
module.exports = { createHQPlayerStreamAdapter };
