const { createHQPlayerComponentManager } = require('./componentManager.cjs');
const { createRpc, handshake } = require('./rpc.cjs');
const { audioError } = require('../nativeAudio/errors.cjs');
const { LIVE_PCM_CONTRACT, LIVE_PCM_COMPONENT_VERSIONS, LIVE_PCM_RELEASE_CONTRACT, requireLivePcmTransport, requireLivePcmReply } = require('../nativeAudio/livePcmFormat.cjs');
const { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef } = require('../debug/privatePreviewDiagnosticBus.cjs');

// Optional HQPlayer facade. No component process starts in the browser/WASAPI/ASIO playback path.
function createHQPlayerComponentHost({ app, configPath, onState = () => {}, onError = () => {},
    manager = require('./wavCandidateManager.cjs').withWavCandidate(createHQPlayerComponentManager({ app }), { app }), rpcFactory = createRpc } = {}) {
    let rpc = null, starting = null, silent = true, generation = 0, managing = false, optionalCapabilities = new Set();
    let streamAuthority = null, pendingStream = null, streamRevision = 0;
    const closingStreams = new Map();
    let componentVersion, reportedInput, loggedInput;
    let workerStarted = false;
    const revokeStream = () => { streamAuthority = null; pendingStream = null; reportedInput = null; ++streamRevision; };
    function reportInput(result, phase, errorCode) {
        if (!isPreviewDiagnosticsEnabled()) return;
        if (reportedInput?.session === result?.session && reportedInput?.generation === result?.generation && reportedInput?.phase === phase) return;
        reportedInput = { session: result?.session, generation: result?.generation, phase };
        publishPreviewDiagnostic('native.hq-input', { sessionRef: previewSessionRef(result?.session), generation: result?.generation,
            phase, errorCode, inputSampleRate: result?.receiverInput?.sampleRate,
            inputChannels: result?.receiverInput?.channels, inputContainerBits: result?.receiverInput?.containerBits });
    }
    function validateLiveReply(result, transport, identity) {
        try {
            requireLivePcmReply(result, transport, identity);
            if (result.errorCode) throw audioError(result.errorCode);
        } catch (error) {
            if (error.code !== 'CANCELLED') reportInput(result, 'rejected', error.code);
            throw error;
        }
        if (result.ready === true) reportInput(result, 'accepted');
        if (result.ready === true && loggedInput !== `${result.session}:${result.generation}`) {
            loggedInput = `${result.session}:${result.generation}`;
            console.info('[HQPlayer input]', JSON.stringify({ session: result.session, generation: result.generation,
                container: result.inputContainer || 'raw', receiverInput: result.receiverInput,
                pcmSampleFormat: transport.sampleFormat, framingToComponent: transport.framing }));
        }
    }
    async function ensure() {
        if (managing) throw audioError('INVALID_REQUEST');
        if (rpc) return rpc;
        if (starting) return starting;
        const ticket = generation;
        starting = (async () => {
            const installed = await manager.status();
            if (!installed.available) throw audioError(installed.errorCode || 'COMPONENT_UNAVAILABLE');
            workerStarted = true;
            const next = rpcFactory(installed.executable, { onEvent: event => {
                if (ticket !== generation) return;
                if (event.event === 'diagnostic' && event.detail?.event === 'wav-http') {
                    console.info('[HQPlayer WAV HTTP]', JSON.stringify(event.detail));
                    return;
                }
                if (event.event === 'diagnostic' && event.detail?.event === 'live-pcm-input') {
                    const detail = event.detail;
                    const authority = streamAuthority?.session === detail.session ? streamAuthority : null;
                    const pending = pendingStream?.session === detail.session && pendingStream.ticket === streamRevision ? pendingStream : null;
                    // Acceptance comes only from the validated ready ACK. Preserve
                    // actual mismatch facts even though rejected status stays unready.
                    if (detail.phase === 'rejected' && (pending?.transport || authority?.transport)
                        && Number.isSafeInteger(detail.generation) && detail.generation > 0
                        && (pending ? !authority || detail.generation > authority.generation : detail.generation === authority.generation)) {
                        reportInput({ session: detail.session, generation: detail.generation, receiverInput: {
                            sampleRate: detail.inputSampleRate, channels: detail.inputChannels,
                            containerBits: detail.inputContainerBits } }, 'rejected', 'FORMAT_UNSUPPORTED');
                    }
                    return;
                }
                if (event.event === 'diagnostic' && event.detail?.event === 'playlist-load') {
                    const { attempt, attempts, coldConnection, result, code } = event.detail;
                    console.info('[HQPlayer preparation]', JSON.stringify({ attempt, attempts, coldConnection, result, code }));
                    return;
                }
                if (event.event === 'diagnostic' && event.detail?.event === 'stream-buffer') {
                    const { waiting, position, decodedEnd, clockIdleMs, inputIdleMs } = event.detail;
                    console.info('[HQPlayer streaming buffer]', JSON.stringify({ waiting, position, decodedEnd, clockIdleMs, inputIdleMs }));
                    return;
                }
                if (event.event === 'state') onState(event.state);
                if (event.event === 'error') { if (['COMPONENT_CRASHED', 'COMPONENT_TIMEOUT'].includes(event.errorCode)) { rpc = null; revokeStream(); } onError(audioError(event.errorCode), event.session); }
            } });
            try {
                const hello = await handshake(next, installed.version);
                await next.request('initialize', { configPath, silent });
                if (ticket !== generation) throw audioError('CANCELLED');
                optionalCapabilities = new Set(hello.capabilities || []); componentVersion = hello.componentVersion; rpc = next; return next;
            } catch (error) { await next.dispose(); throw error; }
        })().finally(() => { if (ticket === generation) starting = null; });
        return starting;
    }
    const invoke = async (action, args) => (await ensure()).request(action, { args });
    async function supportsStreaming({ required = false, sourceKind = 'finite', allowUnverifiedRaw = false } = {}) {
        if (!['finite', 'spotify-live'].includes(sourceKind) || (sourceKind === 'finite' && allowUnverifiedRaw === true)) throw audioError('INVALID_REQUEST');
        await ensure();
        const streaming = ['pcm-streaming', 'pcm32-named-pipe'].every(capability => optionalCapabilities.has(capability));
        // Normal live playback requires this independently versioned wire contract.
        // The old opt-in experiment remains separate and never grants normal authority.
        const confirmedRelease = LIVE_PCM_COMPONENT_VERSIONS.includes(componentVersion) && optionalCapabilities.has(LIVE_PCM_RELEASE_CONTRACT);
        const verifiedLive = confirmedRelease && optionalCapabilities.has(LIVE_PCM_CONTRACT);
        const supported = streaming && (sourceKind === 'finite' || confirmedRelease && (allowUnverifiedRaw === true || verifiedLive));
        if (required && !supported) throw audioError(streaming ? 'HQPLAYER_RAW_FORMAT_UNVERIFIED' : 'COMPONENT_INCOMPATIBLE');
        return supported;
    }
    async function streamPrepare(spec, { allowUnverifiedRaw = false } = {}) {
        if (!spec || !['finite', 'spotify-live'].includes(spec.sourceKind)) throw audioError('INVALID_REQUEST');
        const { sourceKind, ...componentSpec } = spec;
        if (sourceKind === 'finite' && allowUnverifiedRaw === true) throw audioError('INVALID_REQUEST');
        const verifiedLive = sourceKind === 'spotify-live' && allowUnverifiedRaw !== true;
        if (!verifiedLive && spec.transport !== undefined) throw audioError('INVALID_REQUEST');
        const ticket = ++streamRevision; streamAuthority = null;
        const pending = { session: spec.session, ticket, sent: false, transport: verifiedLive ? spec.transport : null }; pendingStream = pending;
        try {
            await supportsStreaming({ required: true, sourceKind, allowUnverifiedRaw });
            if (ticket !== streamRevision) throw audioError('CANCELLED');
            if (verifiedLive) requireLivePcmTransport(spec.transport, spec);
            pending.sent = true;
            const result = await invoke('stream-prepare', [componentSpec]);
            if (ticket !== streamRevision) throw audioError('CANCELLED');
            if (verifiedLive) validateLiveReply(result, spec.transport, { session: spec.session, pipeName: spec.pipeName });
            streamAuthority = { session: spec.session, sourceKind, allowUnverifiedRaw: allowUnverifiedRaw === true,
                transport: verifiedLive ? spec.transport : null, pipeName: spec.pipeName, ticket, generation: result.generation };
            return result;
        } catch (error) {
            if (ticket === streamRevision && pending.sent) {
                revokeStream();
                await invoke('stream-close', [spec.session]).catch(() => {});
            }
            throw error;
        } finally { if (pendingStream === pending) pendingStream = null; }
    }
    async function ownedStream(action, session, args) {
        const authority = streamAuthority;
        if (!authority || authority.session !== session) throw audioError('CANCELLED');
        const requestedGeneration = action === 'stream-reset' ? args[0]?.generation : args[1];
        const ownGeneration = authority.generation;
        if (authority.transport && requestedGeneration !== ownGeneration) throw audioError('CANCELLED');
        if (action === 'stream-reset') {
            const { sourceKind, ...componentSpec } = args[0];
            if (sourceKind !== authority.sourceKind) throw audioError('INVALID_REQUEST');
            if (authority.transport) requireLivePcmTransport(componentSpec.transport, componentSpec);
            else if (componentSpec.transport !== undefined) throw audioError('INVALID_REQUEST');
            args = [componentSpec];
        }
        await supportsStreaming({ required: true, sourceKind: authority.sourceKind, allowUnverifiedRaw: authority.allowUnverifiedRaw });
        if (authority !== streamAuthority || authority.ticket !== streamRevision || authority.generation !== ownGeneration) throw audioError('CANCELLED');
        if (requestedGeneration !== undefined && authority.generation !== undefined && requestedGeneration !== authority.generation) throw audioError('CANCELLED');
        const pending = action === 'stream-reset' ? { session, ticket: authority.ticket, sent: true, transport: authority.transport } : null;
        if (pending) pendingStream = pending;
        try {
        const result = await invoke(action, args);
        if (authority !== streamAuthority || authority.ticket !== streamRevision || authority.generation !== ownGeneration) throw audioError('CANCELLED');
        if (authority.transport) {
            validateLiveReply(result, authority.transport, { session,
                pipeName: action === 'stream-reset' ? args[0].pipeName : authority.pipeName,
                ...(action === 'stream-reset' ? {} : { generation: ownGeneration }) });
            if (action === 'stream-reset' && result.generation <= ownGeneration) throw audioError('CANCELLED');
        }
        if (action === 'stream-reset') streamAuthority = { ...authority, generation: result.generation, pipeName: args[0].pipeName };
        return result;
        } catch (error) {
            // A malformed ACK from this still-current owner also needs cleanup.
            // A replaced authority alone prevents an old request closing new output.
            if (authority.transport && authority === streamAuthority && authority.ticket === streamRevision) {
                revokeStream(); await invoke('stream-close', [session]).catch(() => {});
            }
            throw error;
        } finally { if (pending && pendingStream === pending) pendingStream = null; }
    }
    async function streamClose(session, streamGeneration) {
        const authority = streamAuthority?.session === session ? streamAuthority : null;
        const pending = pendingStream?.session === session ? pendingStream : null;
        let closing = closingStreams.get(session);
        if (!authority && !pending && !closing) return { ok: true };
        if (streamGeneration !== undefined && authority?.generation !== undefined && streamGeneration !== authority.generation) throw audioError('CANCELLED');
        if (!closing) {
            closing = { generation: pending?.sent ? undefined : streamGeneration, sent: Boolean(authority || pending?.sent), task: null };
            closingStreams.set(session, closing);
        }
        if (authority || pending) revokeStream();
        if (!closing.sent) { closingStreams.delete(session); return { ok: true }; }
        if (closing.task) return closing.task;
        // Revoking playback authority must not erase an unacknowledged close. Keep
        // this exact owner/generation as a retry receipt without authorizing Play.
        closing.task = (async () => {
            if (!rpc && !starting) throw audioError('HQPLAYER_CONTROL_UNAVAILABLE');
            const result = await invoke('stream-close', [session, closing.generation]);
            if (closingStreams.get(session) === closing) closingStreams.delete(session);
            return result;
        })();
        void closing.task.catch(() => { closing.task = null; });
        return closing.task;
    }
    async function dispose() {
        revokeStream(); ++generation; const old = rpc; const pending = starting; rpc = null; starting = null; optionalCapabilities = new Set();
        await old?.dispose();
        if (pending) await pending.catch(() => {});
    }
    async function configuration() {
        const component = await manager.status(); const { executable, ...publicComponent } = component;
        if (!component.available) return { available: false, component: publicComponent, errorCode: component.errorCode || 'COMPONENT_UNAVAILABLE' };
        return { ...await invoke('configuration', []), component: publicComponent };
    }
    async function manage(action) {
        if (managing || !['install', 'uninstall', 'rollback'].includes(action)) throw audioError('INVALID_REQUEST');
        managing = true;
        try { await dispose(); await manager[action](); managing = false; return configuration(); } finally { managing = false; }
    }
    return { configuration, dispose, manage, supportsStreaming,
        streamPrepare,
        streamStatus: (session, streamGeneration) => ownedStream('stream-status', session, [session, streamGeneration]),
        streamReset: spec => ownedStream('stream-reset', spec.session, [spec]),
        streamClose,
        configure: async value => { revokeStream(); await invoke('configure', [value]); return configuration(); },
        setSilent: value => { silent = value === true; if (rpc) void rpc.request('setSilent', { args: [silent] }).catch(onError); },
        ...Object.fromEntries(['device', 'prepare', 'checkExisting', 'authorizeExisting', 'load', 'command', 'stop', 'shutdown', 'dspSettings', 'validateExecutable']
            .map(action => [action, (...args) => {
                if (['load', 'shutdown'].includes(action) || (action === 'stop' && (streamAuthority?.session === args[0] || pendingStream?.session === args[0]))) revokeStream();
                // A failed availability check never acquired HQPlayer output. Let
                // the user leave that backend without starting an unavailable worker.
                // Keep recovery mandatory once a worker may have owned output.
                if (action === 'shutdown' && !workerStarted && !rpc && !starting) return Promise.resolve();
                return action === 'stop' && !rpc && !starting ? Promise.resolve() : invoke(action, args);
            }])) };
}
module.exports = { createHQPlayerComponentHost };
