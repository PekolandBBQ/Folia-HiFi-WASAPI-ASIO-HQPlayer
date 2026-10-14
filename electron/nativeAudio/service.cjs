const fs = require('node:fs/promises');
const path = require('node:path');
const { createHelper } = require('./helper.cjs');
const { decodeLocalAudio } = require('./decode.cjs');
const { downloadRemoteAudio } = require('./download.cjs');
const { audioError, errorCode, diagnostic, sourceLifecycleError } = require('./errors.cjs');
const { createHQPlayerComponentHost } = require('../hqplayer/client.cjs');
const { loadHQPlayerSession } = require('./hqplayerSession.cjs');
const { publishPreviewDiagnostic, isPreviewDiagnosticsEnabled, previewSessionRef, previewOperationRef, releasePreviewSession, sourceErrorCode } = require('../debug/privatePreviewDiagnosticBus.cjs');
const { own } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { validateLivePcmPrebufferMs } = require('./livePcmPrebuffer.cjs');
const { validateHQPlayerSpotifyExperiment } = require('./hqplayerSpotifyExperiment.cjs');

// Keep private IPC pipe handles in the main process; UI telemetry needs only audio state.
function publicAudioState(state, sourceInfo) {
    const { pipeName, ...publicState } = state || {};
    return { ...publicState, ...sourceInfo };
}

// electron/nativeAudio/service.cjs — a single, session-owned local playback resource.
function registerNativeAudio({ app, ipcMain, isTrustedSender, helperFactory = createHelper, decode = decodeLocalAudio, download = downloadRemoteAudio, componentManager, hqplayerFactory = createHQPlayerComponentHost, chooseHQPlayerExecutable, decoderResolver = require('./decoder.cjs').resolveNativeDecoder, streamFactory = require('./streamSession.cjs').createStreamSession, resolveLivePcmSource = () => null, prepareSourceOutput = async () => {}, liveStreamFactory = require('./livePcmSession.cjs').createLivePcmSession }) {
    const supported = process.platform === 'win32' && process.arch === 'x64';
    const components = componentManager || require('./componentManager.cjs').createComponentManager({ app });
    const sourceCache = require('./sourceCache.cjs').createSourceCache();
    let active = null, helper = null, helperReady = null, decoder, managingComponent = false;
    let nativeHandoffPending = false;
    let releasing = Promise.resolve(), blockedRelease = null;
    const retainedSources = new Map();
    let outputTransition = Promise.resolve();
    let cleanupStarted = false, cleanupFinished = false;
    // Original encoding and the output container remain separate even for generated live PCM.
    function observeState(current, state) {
        if (!current || !state || !isPreviewDiagnosticsEnabled()) return;
        const fields = { sessionRef: previewSessionRef(current.id), backend: current.backend };
        publishPreviewDiagnostic('native.state', { ...fields, positionSeconds: own(state, 'position'), durationSeconds: own(state, 'duration'),
            playing: own(state, 'playing'), ended: own(state, 'ended'), buffering: own(state, 'buffering'),
            bufferedStart: own(state, 'bufferedStart'), bufferedEnd: own(state, 'bufferedEnd'), producerComplete: own(state, 'producerComplete') });
        const source = current.sourceInfo || {}, format = own(state, 'outputFormat');
        const formats = { 'PCM16 integer direct': 's16le', 'PCM24 integer direct': 's24le', 'PCM32 integer direct': 's32le',
            'PCM float32': 'f32le', 'PCM float64': 'f64le', s16le: 's16le', s24le: 's24le', s32le: 's32le', f32le: 'f32le', f64le: 'f64le' };
        const outputFormat = typeof format === 'string' ? own(formats, format) : undefined;
        const depths = { s16le: 16, s24le: 24, s32le: 32, f32le: 32, f64le: 64 };
        const codec = own(source, 'sourceCodec');
        const codecs = { pcm: 'PCM', flac: 'FLAC', alac: 'ALAC', aac: 'AAC', vorbis: 'VORBIS', opus: 'OPUS',
            mp3: 'MP3', 'mpeg 1 layer 3': 'MP3', dsd: 'DSD', ape: 'APE', wavpack: 'WAVPACK' };
        const sourceCodec = typeof codec === 'string' && codec.length <= 32 ? own(codecs, codec.toLowerCase()) : undefined;
        publishPreviewDiagnostic('native.format', { ...fields, formatStage: 'engine-output', sourceSampleRate: own(source, 'sourceSampleRate'),
            sourceBitsPerSample: own(source, 'sourceBitsPerSample'), sourceBitrate: own(source, 'sourceBitrate'), sourceCodec,
            sourceEncodingVerified: own(source, 'sourceEncodingVerified'), preparedSource: own(source, 'preparedSource'),
            requestedQuality: own(source, 'requestedQuality'), sourceQuality: own(source, 'sourceQuality'),
            outputSampleRate: own(state, 'sampleRate'), outputChannels: own(state, 'channels'), outputFormat,
            outputBitsPerSample: outputFormat ? own(depths, outputFormat) : undefined });
    }
    function observeError(current, error) {
        if (!isPreviewDiagnosticsEnabled()) return;
        publishPreviewDiagnostic('native.command', { operation: 'unknown', phase: 'result', ok: false,
            sessionRef: previewSessionRef(current?.id), backend: current?.backend, errorCode: sourceErrorCode(error) });
    }
    const hqplayer = hqplayerFactory({
        app,
        configPath: path.join(app.getPath('userData'), 'hqplayer.json'),
        onState: state => {
            const current = active;
            if (!current || current.backend !== 'hqplayer' || current.id !== state.session || current.sender.isDestroyed()) return;
            if (current.stream && !current.stream.observe(state)) return;
            observeState(current, state);
            current.sender.send('native-audio:event', { event: 'state', session: current.id, state: publicAudioState(state, current.sourceInfo) });
        },
        onError: error => {
            diagnostic(error);
            const current = active;
            if (!current || current.backend !== 'hqplayer' || current.sender.isDestroyed()) return;
            observeError(current, error);
            current.sender.send('native-audio:event', { event: 'error', session: current.id, errorCode: errorCode(error) });
        },
    });
    async function ensureHelper() {
        if (helperReady) return helperReady;
        helperReady = (async () => {
            if (helper) {
                const retiring = helper; retiring.dispose(); await retiring.waitForExit?.();
                if (helper === retiring) helper = null;
            }
            const installed = await components.status();
            if (!installed.available) throw audioError(installed.errorCode || 'COMPONENT_UNAVAILABLE', installed.error || 'Install a compatible native audio component first');
            decoder = await decoderResolver(app);
            const ownedHelper = helperFactory(installed.executable, event => {
                if (helper !== ownedHelper) return;
                if (event.event === 'error' && !event.session) helperReady = null;
                const current = active;
                if (!current || current.backend === 'hqplayer' || current.sender.isDestroyed()) return;
                if ((event.session || event.state?.session) && (event.session || event.state.session) !== current.id) return;
                if (event.state && current.stream && !current.stream.observe(event.state)) return;
                if (event.state) observeState(current, event.state);
                if (event.event === 'error') observeError(current, { code: event.errorCode });
                current.sender.send('native-audio:event', { ...event, state: event.state ? publicAudioState(event.state, current.sourceInfo) : undefined, session: current.id });
            });
            helper = ownedHelper;
            const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
            if (hello.protocolMajor !== 1 || !['integer-pcm', 'replaygain', 'format-telemetry'].every(capability => hello.capabilities?.includes(capability))
                || (installed.version && hello.componentVersion !== installed.version)) {
                ownedHelper.dispose(); await ownedHelper.waitForExit?.();
                if (helper === ownedHelper) helper = null;
                throw audioError('COMPONENT_INCOMPATIBLE', 'Unsupported native audio component protocol or capabilities');
            }
            helper.capabilities = hello.capabilities;
            return helper;
        })().catch(error => { helperReady = null; throw error; });
        return helperReady;
    }

    function progress(current, stage, values = {}) {
        if (active !== current || current.abort.signal.aborted || current.sender.isDestroyed()) return;
        const now = Date.now(), elapsedMs = now - (current.preparationStartedAt ?? current.startedAt);
        if (current.stage !== stage) {
            console.info('[PlaybackPreparation]', { session: current.id, stage, previousStage: current.stage, elapsedMs });
            current.stage = stage;
        }
        if (isPreviewDiagnosticsEnabled()) publishPreviewDiagnostic('native.progress', { sessionRef: previewSessionRef(current.id), backend: current.backend,
            stage, elapsedMs, loaded: own(values, 'loaded'), total: own(values, 'total'), complete: own(values, 'complete'), unit: own(values, 'unit') });
        current.sender.send('native-audio:event', { event: 'progress', session: current.id,
            progress: { stage, elapsedMs, ...values } });
    }
    function assertCurrent(session) {
        if (active !== session || session.abort.signal.aborted) throw audioError('CANCELLED', 'Playback request was cancelled');
    }
    function release(session, releaseReason = 'unknown') {
        // Clearing active never clears ownership of a failed cleanup. A later begin
        // retries that exact owner and cannot acquire output until restoration succeeds.
        if (!session) return releasing.then(() => {
            if (blockedRelease) return release(blockedRelease, blockedRelease.releaseReason);
        });
        if (session.releasing) return session.releasing;
        session.abort.abort(); session.releaseReason = releaseReason;
        const work = releasing.then(async () => {
            if (blockedRelease && blockedRelease !== session) throw blockedRelease.releaseError;
            return releaseSession(session, releaseReason);
        });
        session.releasing = work;
        releasing = work.then(() => {
            if (blockedRelease === session) blockedRelease = null;
        }, error => {
            session.releaseError = error; session.releasing = null; blockedRelease ||= session;
        });
        return work;
    }
    async function stopOutput(session) {
        if (session.outputReleased) return;
        if (session.backend === 'hqplayer') await hqplayer.stop(session.id);
        else if (session.loadRequested) await helper?.request({ action: 'stop', session: session.id });
        session.outputReleased = true;
    }
    async function releaseSession(session, releaseReason) {
        const reference = isPreviewDiagnosticsEnabled() ? previewSessionRef(session.id) : undefined;
        if (reference !== undefined) publishPreviewDiagnostic('native.release', { sessionRef: reference, backend: session.backend, phase: 'request', reason: releaseReason });
        let acknowledged = false, retainSource = releaseReason === 'handoff' && !session.streamFailed;
        try {
            session.abort.abort();
            const failures = [];
            try { await stopOutput(session); } catch (error) { failures.push(error); }
            // Healthy same-song handoff keeps the route. A failed source may already
            // be blocked; acknowledge its exact quiescence instead of pausing a revoked reader.
            const closeSource = async retain => {
                if (session.stream) await session.stream.close({ retainSource: retain });
                else if (session.livePcmSource) {
                    if (retain) await session.livePcmSource.pause();
                    else if (session.livePcmSource.stop) await session.livePcmSource.stop();
                    else await session.livePcmSource.pause();
                }
            };
            try { await closeSource(retainSource); }
            catch (error) {
                if (!retainSource || !session.livePcmSource) failures.push(sourceLifecycleError(error));
                else {
                    // Resumed preparation can fail before the streaming error callback.
                    // Stop must still prove quiescence; failure keeps the release barrier.
                    retainSource = false;
                    try { await closeSource(false); }
                    catch (cleanupError) { failures.push(sourceLifecycleError(cleanupError)); }
                }
            }
            await session.decoding?.catch(() => {});
            await session.creating?.catch(() => {});
            if (failures.length) throw failures[0];
            if (session.livePcmSource) {
                if (retainSource) retainedSources.set(session.id, { source: session.livePcmSource, sender: session.sender });
                else for (const [id, entry] of retainedSources) if (entry.source === session.livePcmSource) retainedSources.delete(id);
            }
            if (session.cachedSource) await sourceCache.release(session.cachedSource);
            else if (session.directory) await fs.rm(session.directory, { recursive: true, force: true });
            acknowledged = true;
        } finally {
            if (reference !== undefined) {
                publishPreviewDiagnostic('native.release', { sessionRef: reference, backend: session.backend, phase: 'release', reason: releaseReason,
                    ok: acknowledged, releaseAcknowledged: acknowledged });
                publishPreviewDiagnostic('native.device', { sessionRef: reference, backend: session.backend, phase: acknowledged ? 'released' : 'failed' });
            }
            if (acknowledged) releasePreviewSession(session.id);
        }
    }
    // Claim before any await; a superseded decoder or upload can never load over the new song.
    async function begin(request, sender) {
        if (managingComponent) throw new Error('Component operation is in progress');
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(request.session || '')) throw new Error('Invalid session');
        if (!['wasapi-exclusive', 'asio', 'hqplayer'].includes(request.backend) || typeof request.deviceId !== 'string' || !request.deviceId)
            throw new Error('Select an output device');
        if (request.path != null && (typeof request.path !== 'string' || !path.isAbsolute(request.path) || request.path.startsWith('\\\\')))
            throw new Error('Only local absolute file paths are supported');
        if (request.path != null && request.url != null) throw new Error('Choose one audio source');
        if (request.url != null) {
            if (typeof request.url !== 'string' || request.url.length > 16384) throw new Error('Invalid audio URL');
            const url = new URL(request.url);
            if ((!['http:', 'https:'].includes(url.protocol) && !require('../transcode/protocol.cjs').parseTranscodeUrl(request.url)) || url.username || url.password) throw new Error('Only HTTP(S) audio URLs are supported');
        }
        const processingMode = request.processingMode ?? 'compatibility';
        if (!['compatibility', 'integer-direct'].includes(processingMode)) throw new Error('Invalid processing mode');
        if (request.backend === 'hqplayer' && request.deviceId !== 'hqplayer-local') throw audioError('INVALID_REQUEST', 'Invalid HQPlayer endpoint');
        const hqplayerGainDb = request.hqplayerGainDb ?? -2;
        if (!Number.isFinite(hqplayerGainDb) || hqplayerGainDb < -120 || hqplayerGainDb > 0) throw audioError('INVALID_REQUEST', 'Invalid HQPlayer gain');
        if (request.sourceName != null && (typeof request.sourceName !== 'string' || request.sourceName.length > 512)) throw audioError('INVALID_REQUEST', 'Invalid source name');
        if (request.mimeType != null && (typeof request.mimeType !== 'string' || request.mimeType.length > 256)) throw audioError('INVALID_REQUEST', 'Invalid MIME type');
        if (request.trackKey != null && (typeof request.trackKey !== 'string' || request.trackKey.length > 2048)) throw audioError('INVALID_REQUEST');
        if (request.duration != null && (!Number.isFinite(request.duration) || request.duration < 0 || request.duration > 604800)) throw audioError('INVALID_REQUEST', 'Invalid song duration');
        if (request.sessionBoundAudio != null && typeof request.sessionBoundAudio !== 'boolean') throw audioError('INVALID_REQUEST', 'Invalid source session policy');
        if (request.position != null && (!Number.isFinite(request.position) || request.position < 0 || request.position > 604800))
            throw audioError('INVALID_REQUEST', 'Invalid initial position');
        const sourceMetadata = require('./sourceInfo.cjs').normalizeSourceMetadata(request.sourceMetadata);
        const hqplayerSpotifyExperiment = validateHQPlayerSpotifyExperiment(request.hqplayerSpotifyExperiment);
        // Older renderers may only send the HQ experimental target; new renderers always send the canonical value.
        const livePcmPrebufferMs = validateLivePcmPrebufferMs(request.livePcmPrebufferMs === undefined
            && request.backend === 'hqplayer' && hqplayerSpotifyExperiment.enabled
            ? Math.min(1000, hqplayerSpotifyExperiment.prebufferMs) : request.livePcmPrebufferMs);
        const previous = active;
        const current = { id: request.session, sender, abort: new AbortController(), directory: null,
            backend: request.backend, deviceId: request.deviceId, processingMode, hqplayerGainDb, hqplayerSpotifyExperiment, livePcmPrebufferMs, hqplayerDefaults: request.hqplayerDefaults, compatibilityMode: request.compatibilityMode === true, sessionBoundAudio: request.sessionBoundAudio === true, trackKey: request.trackKey, sourceName: request.sourceName, sourceMimeType: request.mimeType, sourceMetadata, initialPosition: request.position || 0, durationHint: request.duration || 0, startedAt: Date.now(), bytes: 0, ready: false };
        active = current;
        await outputTransition;
        assertCurrent(current);
        await release(null);
        const sameSource = previous && previous.remoteUrl && previous.remoteUrl === request.url && previous.trackKey === request.trackKey;
        await release(previous, sameSource ? 'handoff' : 'replaced');
        assertCurrent(current);
        // A provider exit is distinct from stopping a deck. Resolve it before any
        // replacement output can acquire a device, including local/upload sources.
        try { await prepareSourceOutput(request.url, request.backend); }
        catch (error) { throw sourceLifecycleError(error); }
        assertCurrent(current);
        progress(current, current.backend === 'hqplayer' ? 'connect' : 'load');
        if (current.backend === 'hqplayer') {
            // Connect while staging the source; native HQPlayer formats do not need FFmpeg.
            await hqplayer.checkExisting?.();
            assertCurrent(current);
            hqplayer.setSilent?.(request.silent !== false);
            current.connection = hqplayer.prepare?.().then(() => null, error => error);
        } else await ensureHelper();
        assertCurrent(current);
        // A registered main-process producer, never a renderer flag, selects the no-file path.
        const liveSourceUrl = request.url ? new URL(request.url) : null;
        if (liveSourceUrl) liveSourceUrl.hash = '';
        // Match the HTTP URL's actual canonical identity, not renderer spelling. Keep query
        // strings: the private proxy matches them exactly and rejects added parameters.
        const localhostAlias = liveSourceUrl && ['localhost', 'localhost.'].includes(liveSourceUrl.hostname);
        if (localhostAlias) liveSourceUrl.hostname = '127.0.0.1';
        current.livePcmSource = liveSourceUrl ? resolveLivePcmSource(liveSourceUrl.href) : null;
        // The proxy's strict Host check rejects these names; do not reinterpret or download
        // a registered live URL through a DNS alias. Ordinary unrelated URLs stay unchanged.
        if (localhostAlias && current.livePcmSource) { current.abort.abort(); throw audioError('INVALID_REQUEST', 'Use the registered live PCM source URL'); }
        if (current.livePcmSource) {
            for (const [id, entry] of retainedSources) if (entry.source === current.livePcmSource) retainedSources.delete(id);
            current.remoteUrl = request.url; current.upload = false; current.sessionBoundAudio = true;
            current.durationHint = current.livePcmSource.durationMs / 1000;
            // A renderer's sourceFormat/quality cannot turn captured PCM into
            // verified original Spotify encoding or authorize its HQ wire format.
            current.sourceMetadata = { requestedQuality: sourceMetadata?.requestedQuality, preparedAudio: { representation: 's32le',
                sampleRate: current.livePcmSource.sampleRate, channels: current.livePcmSource.channels, bitDepth: 32 } };
            return { ok: true };
        }
        current.creating = fs.mkdtemp(path.join(app.getPath('temp'), 'folia-native-audio-'));
        current.directory = await current.creating;
        assertCurrent(current);
        if (request.path != null) {
            current.input = request.path;
        } else {
            current.input = path.join(current.directory, 'input.audio');
            await fs.writeFile(current.input, Buffer.alloc(0));
        }
        current.remoteUrl = request.url;
        current.upload = request.path == null && request.url == null;
        return { ok: true };
    }
    async function handle(event, request) {
        if (!isTrustedSender(event.sender) || (event.senderFrame && event.senderFrame !== event.sender.mainFrame))
            throw new Error('Untrusted audio caller');
        if (cleanupStarted) throw audioError('CANCELLED', 'Application is quitting');
        if (request?.action === 'status') {
            if (!supported) return { supported, available: false };
            const state = await components.status();
            let decoderError;
            if (state.available) try { await decoderResolver(app); } catch (error) { decoderError = 'COMPONENT_UNAVAILABLE'; diagnostic(audioError(decoderError, error.message)); }
            const { executable, error, ...publicState } = state;
            return { ...publicState, supported, available: state.available && !decoderError, errorCode: decoderError || state.errorCode };
        }
        if (request?.action === 'hqplayer-status') return { supported, ...(!supported ? { available: false } : hqplayer.configuration ? await hqplayer.configuration() : { available: Boolean(await hqplayer.device()) }) };
        if (!supported) throw new Error('Native playback requires Windows x64');
        if (request?.action === 'cached-source') {
            if (typeof request.url !== 'string' || request.url.length > 16384 || typeof request.trackKey !== 'string' || request.trackKey.length > 2048) throw audioError('INVALID_REQUEST');
            return sourceCache.read(request);
        }
        if (request?.action === 'hqplayer-window') return require('./hqplayerWindow.cjs').hqplayerWindow(request.visible);
        if (request?.action === 'hqplayer-shutdown') {
            const previous = active?.backend === 'hqplayer' ? active : null;
            if (previous) active = null;
            const work = outputTransition.catch(() => {}).then(async () => {
                if (previous) await release(previous, request.reason === 'handoff' ? 'handoff' : 'stop');
                await release(null);
                await hqplayer.shutdown();
                nativeHandoffPending = true;
                // Await this complete shutdown before any new begin can acquire output.
                await helperReady?.catch(() => {});
                const retiring = helper; retiring?.dispose(); await retiring?.waitForExit?.();
                if (helper === retiring) { helper = null; helperReady = null; }
                return { ok: true };
            });
            outputTransition = work;
            void work.catch(() => {});
            return work;
        }
        if (['hqplayer-component-install', 'hqplayer-component-uninstall', 'hqplayer-component-rollback'].includes(request?.action)) {
            if (active?.backend === 'hqplayer') throw audioError('INVALID_REQUEST', 'Switch away from HQPlayer before managing its component');
            return hqplayer.manage(request.action.slice('hqplayer-component-'.length));
        }
        if (request?.action === 'hqplayer-authorize-existing') return hqplayer.authorizeExisting(request.instancePid);
        if (request?.action === 'hqplayer-launch-options') { hqplayer.setSilent(request.silent !== false); return { ok: true }; }
        if (request?.action === 'hqplayer-dsp-read') return hqplayer.dspSettings();
        if (request?.action === 'hqplayer-dsp-apply') {
            if (active && active.sender !== event.sender) throw audioError('INVALID_REQUEST');
            if (request.when === 'current' && (!active?.ready || active.backend !== 'hqplayer')) throw audioError('INVALID_REQUEST');
            let result = await hqplayer.dspSettings(request.settings, request.when, request.session);
            if (request.when === 'current' && active?.id === result.session && active.sender === event.sender) {
                const current = active;
                if (result.needsStreamRestart && current.stream) {
                    // RAW sources cannot seek in HQPlayer: rebuild the producer at the checkpoint.
                    await current.stream.command('seek', { position: result.position });
                    assertCurrent(current);
                    result = await current.stream.command('play', {});
                    assertCurrent(current);
                }
                // Only this explicit user action may resume a paused renderer transport.
                event.sender.send('native-audio:event', { event: 'resume', session: result.session, state: publicAudioState(result, current.sourceInfo) });
            }
            return publicAudioState(result, active?.id === result.session ? active.sourceInfo : undefined);
        }
        if (['hqplayer-select-executable', 'hqplayer-reset-executable'].includes(request?.action)) {
            let selected = null;
            if (request.action === 'hqplayer-select-executable') {
                const choose = chooseHQPlayerExecutable || (async () => {
                    const { dialog, BrowserWindow } = require('electron');
                    const owner = BrowserWindow.fromWebContents(event.sender);
                    const options = { title: 'Select HQPlayer Desktop executable', properties: ['openFile'], filters: [{ name: 'HQPlayer Desktop', extensions: ['exe'] }] };
                    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
                    return result.canceled ? null : result.filePaths[0];
                });
                selected = await choose();
                if (!selected) return { canceled: true };
                if (!await hqplayer.validateExecutable(selected)) throw audioError('HQPLAYER_PATH_INVALID', 'Select HQPlayer Desktop executable');
            }
            if (active?.backend === 'hqplayer') { const previous = active; active = null; await release(previous); }
            return { canceled: false, ...await hqplayer.configure(selected) };
        }
        if (['component-install', 'component-uninstall', 'component-rollback'].includes(request?.action)) {
            if ((active && active.backend !== 'hqplayer') || managingComponent) throw new Error('Release WASAPI/ASIO playback and wait for any component operation to finish');
            managingComponent = true;
            try {
                const retiring = helper; retiring?.dispose(); await retiring?.waitForExit?.();
                if (helper === retiring) { helper = null; helperReady = null; }
                await (request.action === 'component-install' ? components.install() : request.action === 'component-rollback' ? components.rollback() : components.uninstall()); }
            catch (error) { throw error.code ? error : audioError('COMPONENT_UPDATE_FAILED', error.message); }
            finally { managingComponent = false; }
            return { ok: true };
        }
        if (request?.action === 'devices') return (await ensureHelper()).request({ action: 'devices' });
        if (request?.action === 'begin') return begin(request, event.sender);
        const current = active;
        // Disposal can race StrictMode remounts or a newer source. A stale stop is a no-op,
        // never permission to stop whichever track happens to own the driver now.
        if (request?.action === 'stop' && (!current || request.session !== current.id)) {
            if (blockedRelease?.id === request.session && blockedRelease.sender === event.sender) await release(blockedRelease, 'stop');
            const retained = retainedSources.get(request.session);
            if (request.reason !== 'handoff' && retained?.sender === event.sender && active?.livePcmSource !== retained.source) {
                try { if (retained.source.stop) await retained.source.stop(); else await retained.source.pause(); }
                catch (error) { throw sourceLifecycleError(error); }
                if (retainedSources.get(request.session) === retained) retainedSources.delete(request.session);
            }
            return { ok: true };
        }
        if (!current || request?.session !== current.id || event.sender !== current.sender) throw audioError('CANCELLED', 'Stale playback session');
        // A producer failure aborts playback, but its exact owner still owes Stop cleanup.
        if (request.action === 'stop') {
            active = null;
            await release(current, request.reason === 'handoff' ? 'handoff' : 'stop');
            return { ok: true };
        }
        assertCurrent(current);
        if (request.action === 'chunk') {
            const data = request.data;
            if (!current.upload || current.decoding || !ArrayBuffer.isView(data) || data.byteLength > 1024 * 1024)
                throw new Error('Invalid audio upload');
            if (current.bytes + data.byteLength > 2 * 1024 ** 3) throw new Error('Local file exceeds the 2 GiB staging limit');
            current.bytes += data.byteLength;
            await fs.appendFile(current.input, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            assertCurrent(current);
            return { ok: true };
        }
        if (request.action === 'finish') {
            if (current.decoding) throw new Error('File is already being prepared');
            current.decoding = (async () => {
                if (current.livePcmSource) {
                    const useHQStream = current.backend === 'hqplayer';
                    if (useHQStream ? !await hqplayer.supportsStreaming?.({ required: true, sourceKind: 'spotify-live', allowUnverifiedRaw: current.hqplayerSpotifyExperiment.enabled }) : !helper.capabilities?.includes('streaming-pcm-v1'))
                        throw audioError('COMPONENT_INCOMPATIBLE', 'Live PCM requires a streaming output component');
                    assertCurrent(current);
                    current.sourceInfo = await require('./sourceInfo.cjs').readOriginalSourceInfo(current);
                    assertCurrent(current);
                    // A live producer cannot wait for Desktop launch with an undrained
                    // bounded capture queue. Finish the already-started connection first.
                    if (useHQStream) {
                        progress(current, 'connect');
                        const connectionError = await current.connection;
                        assertCurrent(current);
                        if (connectionError) throw connectionError;
                    }
                    const streamHelper = useHQStream ? require('./hqplayerStreamAdapter.cjs').createHQPlayerStreamAdapter({ current, hqplayer }) : helper;
                    current.stream = liveStreamFactory({ current, getPrebufferMs: () => current.livePcmPrebufferMs, source: current.livePcmSource, helper: streamHelper, progress, assertCurrent,
                        releaseOutput: async () => {
                            await stopOutput(current);
                            if (useHQStream) await streamHelper.close();
                        },
                        ...(useHQStream && current.hqplayerSpotifyExperiment.enabled ? { experiment: current.hqplayerSpotifyExperiment } : {}),
                        openOutput: payload => { current.outputReleased = false; return useHQStream ? streamHelper.request(payload) : require('./reopenAfterHQPlayer.cjs').reopenAfterHQPlayer(() => {
                            assertCurrent(current); return streamHelper.request(payload);
                        }, { signal: current.abort.signal, recovering: nativeHandoffPending, onRetry: () => progress(current, 'connect') }); },
                        onError: error => {
                            if (active !== current || current.abort.signal.aborted || current.streamFailed) return;
                            current.streamFailed = true; diagnostic(error);
                            observeError(current, error);
                            current.sender.send('native-audio:event', { event: 'error', session: current.id, errorCode: errorCode(error) });
                            current.abort.abort(); void streamHelper.request({ action: 'stop', session: current.id }).catch(() => {});
                        } });
                    progress(current, 'buffer', { loaded: 0, total: current.livePcmPrebufferMs, unit: 'milliseconds' });
                    const result = await current.stream.prepare(current.initialPosition);
                    assertCurrent(current); current.ready = true; nativeHandoffPending = false;
                    return publicAudioState(result, current.sourceInfo);
                }
                if (current.remoteUrl) {
                    const cached = current.sessionBoundAudio ? null : await sourceCache.read({ url: current.remoteUrl, trackKey: current.trackKey });
                    assertCurrent(current); current.downloadUrl = cached?.url || current.remoteUrl;
                    const sessionFetch = current.sender.session?.fetch?.bind(current.sender.session);
                    if (!sessionFetch && download === downloadRemoteAudio) throw audioError('SOURCE_UNAVAILABLE', 'Electron session fetch is unavailable');
                    const useHQStream = current.backend === 'hqplayer' && await hqplayer.supportsStreaming?.();
                    if (useHQStream || (current.backend !== 'hqplayer' && helper.capabilities?.includes('streaming-pcm-v1'))) {
                        if (useHQStream) decoder = await decoderResolver(app);
                        const streamHelper = useHQStream ? require('./hqplayerStreamAdapter.cjs').createHQPlayerStreamAdapter({ current, hqplayer, assertCurrent }) : helper;
                        current.stream = streamFactory({ current, helper: streamHelper, executable: decoder, fetchImpl: sessionFetch,
                            openOutput: payload => useHQStream ? streamHelper.request(payload) : require('./reopenAfterHQPlayer.cjs').reopenAfterHQPlayer(() => {
                                assertCurrent(current); return streamHelper.request(payload);
                            }, { signal: current.abort.signal, recovering: nativeHandoffPending, onRetry: () => progress(current, 'connect') }),
                            progress, assertCurrent, onError: error => {
                                if (active !== current || current.abort.signal.aborted || current.streamFailed) return;
                                current.streamFailed = true; diagnostic(error);
                                observeError(current, error);
                                current.sender.send('native-audio:event', { event: 'error', session: current.id, errorCode: errorCode(error) });
                                current.abort.abort();
                                void streamHelper.request({ action: 'stop', session: current.id }).catch(() => {});
                            } });
                        if (!current.sessionBoundAudio) current.cachedSource = sourceCache.track({ url: current.remoteUrl, trackKey: current.trackKey,
                            file: current.input, directory: current.directory, completion: current.stream.source.downloaded, contentType: () => current.sourceMimeType });
                        progress(current, 'buffer', { loaded: 0, total: 350, unit: 'milliseconds' });
                        try {
                            const result = await current.stream.prepare();
                            assertCurrent(current); current.ready = true; nativeHandoffPending = false;
                            return publicAudioState(result, current.sourceInfo);
                        } catch (error) {
                            // Some finite containers require a tail index. Fall back before first playback only.
                            if (error.code !== 'DECODE_FAILED' || current.abort.signal.aborted || current.streamFailed) throw error;
                            console.info('[PlaybackPreparation]', { session: current.id, streamingFallback: 'container-or-probe' });
                            await current.stream.source.downloaded;
                            await current.stream.close(); current.stream = null;
                            if (current.loadRequested) await streamHelper.request({ action: 'stop', session: current.id });
                            assertCurrent(current);
                        }
                    } else {
                    progress(current, 'download');
                    const downloading = download(current.downloadUrl, current.input, current.abort.signal, sessionFetch, values => progress(current, 'download', values));
                    if (!current.sessionBoundAudio) current.cachedSource = sourceCache.track({ url: current.remoteUrl, trackKey: current.trackKey,
                        file: current.input, directory: current.directory, completion: downloading, contentType: () => current.sourceMimeType });
                    const downloaded = await downloading;
                    if (downloaded?.contentType) current.sourceMimeType = downloaded.contentType;
                    }
                }
                assertCurrent(current);
                progress(current, 'inspect');
                current.sourceInfo = await require('./sourceInfo.cjs').readOriginalSourceInfo(current);
                assertCurrent(current);
                if (current.backend === 'hqplayer') {
                    progress(current, 'connect');
                    const connectionError = await current.connection;
                    if (connectionError) throw connectionError;
                    assertCurrent(current);
                    progress(current, 'load');
                    const result = await loadHQPlayerSession({ current, hqplayer, decoder, resolveDecoder: () => decoderResolver(app), decode, assertCurrent, onProgress: stage => progress(current, stage) });
                    assertCurrent(current); current.ready = true;
                    return publicAudioState(result, current.sourceInfo);
                }
                progress(current, 'decode');
                const wav = await decode(decoder, current.input, current.directory, current.abort.signal, current.processingMode, current.compatibilityMode)
                    .catch(error => { throw audioError(current.abort.signal.aborted ? 'CANCELLED' : error.code === 'STRICT_DECODE_FAILED' ? error.code : 'DECODE_FAILED', error.message); });
                assertCurrent(current);
                progress(current, 'load');
                current.loadRequested = true;
                const result = await require('./reopenAfterHQPlayer.cjs').reopenAfterHQPlayer(() => {
                    assertCurrent(current);
                    return helper.request({ action: 'load', session: current.id, path: wav,
                        backend: current.backend, deviceId: current.deviceId, processingMode: current.processingMode });
                }, { signal: current.abort.signal, recovering: nativeHandoffPending,
                    onRetry: () => progress(current, 'connect') });
                assertCurrent(current);
                nativeHandoffPending = false;
                current.ready = true;
                return publicAudioState(result, current.sourceInfo);
            })();
            return current.decoding;
        }
        const actions = current.backend === 'hqplayer' ? ['play', 'pause', 'seek', 'volume', 'replaygain', 'gain'] : ['play', 'pause', 'seek', 'volume', 'replaygain'];
        if (!current.ready || !actions.includes(request.action)) throw new Error('Audio is not ready');
        if (request.action === 'seek' && (!Number.isFinite(request.position) || request.position < 0)) throw new Error('Invalid seek');
        if (request.action === 'volume' && (!Number.isFinite(request.volume) || request.volume < 0 || request.volume > 1)) throw new Error('Invalid volume');
        if (request.action === 'replaygain' && (!Number.isFinite(request.gain) || request.gain < 0 || request.gain > 16)) throw new Error('Invalid ReplayGain');
        if (current.backend === 'hqplayer' && request.action === 'gain' && (!Number.isFinite(request.gainDb) || request.gainDb < -120 || request.gainDb > 0)) throw audioError('INVALID_REQUEST', 'Invalid HQPlayer gain');
        if (request.livePcmPrebufferMs !== undefined) {
            const target = validateLivePcmPrebufferMs(request.livePcmPrebufferMs);
            if (current.livePcmSource && ['play', 'seek'].includes(request.action)) current.livePcmPrebufferMs = target;
        }
        if (current.stream) {
            // The target configures main-owned readiness; it is not part of the installed output helper protocol.
            const { livePcmPrebufferMs: _prebuffer, ...streamRequest } = request;
            return publicAudioState(await current.stream.command(request.action, streamRequest), current.sourceInfo);
        }
        if (current.backend === 'hqplayer') {
            if (request.action === 'gain' && (!Number.isFinite(request.gainDb) || request.gainDb < -120 || request.gainDb > 0)) throw audioError('INVALID_REQUEST', 'Invalid HQPlayer gain');
            const value = request.action === 'seek' ? request.position : request.action === 'volume' ? request.volume : request.action === 'replaygain' ? request.gain : request.gainDb;
            return publicAudioState(await hqplayer.command(current.id, request.action, value), current.sourceInfo);
        }
        return publicAudioState(await helper.request({ action: request.action, session: current.id, position: request.position, volume: request.volume, gain: request.gain }), current.sourceInfo);
    }
    async function observedHandle(event, request) {
        if (!isPreviewDiagnosticsEnabled() || !isTrustedSender(event.sender)
            || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) return handle(event, request);
        const operation = own(request, 'action');
        // Chunk uploads have their own byte counts; copying or logging upload payloads is forbidden.
        if (operation === 'chunk') return handle(event, request);
        const session = own(request, 'session'), reference = previewSessionRef(session);
        const backend = own(request, 'backend') || (active && active.id === session ? active.backend : undefined);
        const fields = { operation, operationRef: previewOperationRef(), sessionRef: reference, backend };
        publishPreviewDiagnostic('native.command', { ...fields, phase: 'request', positionSeconds: own(request, 'position') });
        if (operation === 'finish') publishPreviewDiagnostic('native.device', { ...fields, phase: 'opening' });
        try {
            const result = await handle(event, request);
            publishPreviewDiagnostic('native.command', { ...fields, phase: 'result', ok: true });
            if (active?.id === session) observeState(active, result);
            if (operation === 'finish') publishPreviewDiagnostic('native.device', { ...fields, phase: 'opened' });
            if (operation === 'devices') publishPreviewDiagnostic('native.device', { phase: 'enumerated', deviceCount: Array.isArray(result) ? result.length : own(result, 'devices')?.length });
            return result;
        } catch (error) {
            publishPreviewDiagnostic('native.command', { ...fields, phase: 'result', ok: false, errorCode: sourceErrorCode(error) });
            if (operation === 'finish') publishPreviewDiagnostic('native.device', { ...fields, phase: 'failed', errorCode: sourceErrorCode(error) });
            throw error;
        }
    }
    ipcMain.handle('native-audio:request', async (event, request) => {
        try { return await observedHandle(event, request); }
        catch (error) { diagnostic(error); return { nativeAudioError: { code: errorCode(error) } }; }
    });
    app.on('web-contents-created', (_, contents) => {
        const stop = () => { if (active?.sender === contents) { const previous = active; active = null; void release(previous, 'renderer-gone').catch(diagnostic); } };
        contents.on('destroyed', stop);
        contents.on('render-process-gone', stop);
        contents.on('did-start-navigation', (_, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) stop(); });
    });
    app.on('session-bound-audio-revoked', (_event = {}) => {
        const providerId = _event.providerId;
        if (active?.sessionBoundAudio && typeof providerId === 'string' && active.trackKey?.startsWith(`online:${providerId}:`)) {
            const previous = active; active = null; void release(previous, 'provider-change').catch(diagnostic);
        }
    });
    app.on('before-quit', event => {
        if (cleanupFinished) return;
        // Electron does not await a Promise returned by this event. Hold the first quit,
        // including duplicate requests, until owned resources are released.
        event?.preventDefault?.();
        if (cleanupStarted) return;
        cleanupStarted = true;
        const previous = active; active = null;
        const lifecycleSenders = new Set([previous?.sender, ...Array.from(retainedSources.values(), entry => entry.sender)].filter(Boolean));
        // Keep the process alive until restoration is acknowledged. Failure leaves the
        // owned receipt retryable; a second user Quit retries rather than reporting success.
        const cleanup = (async () => {
            // A failed process shutdown must not skip source restoration on Quit.
            // Known output owners are still stopped/acknowledged by release below.
            await outputTransition.catch(diagnostic);
            await release(null);
            await release(previous, 'shutdown');
            for (const [id, retained] of retainedSources) {
                try { if (retained.source.stop) await retained.source.stop(); else await retained.source.pause(); }
                catch (error) { throw sourceLifecycleError(error); }
                if (retainedSources.get(id) === retained) retainedSources.delete(id);
            }
            await sourceCache.dispose();
            helper?.dispose(); await helper?.waitForExit?.(); await hqplayer.dispose();
        })();
        void cleanup.then(() => { cleanupFinished = true; app.quit?.(); }, error => {
            cleanupStarted = false;
            diagnostic(error);
            if (errorCode(error) === 'SOURCE_RESTORE_UNCONFIRMED') {
                for (const sender of lifecycleSenders) if (!sender.isDestroyed()) sender.send('native-audio:event', {
                    event: 'lifecycle-error', errorCode: 'SOURCE_RESTORE_UNCONFIRMED' });
            } else if (previous && !previous.sender.isDestroyed()) previous.sender.send('native-audio:event', {
                event: 'error', session: previous.id, errorCode: errorCode(error) });
        });
    });
    return { handle: observedHandle,
        async releaseProviderOutput() {
            // Registered live sources belong to the main-process Spotify resolver.
            // A renderer trackKey/provider flag cannot authorize this release.
            const previous = active?.livePcmSource ? active : null;
            if (previous) active = null;
            await outputTransition;
            if (previous) { previous.abort.abort(); await stopOutput(previous); }
            const complete = async () => {
                await release(null);
                await release(previous, 'provider-change');
                for (const [id, retained] of retainedSources) {
                    try { if (retained.source.stop) await retained.source.stop(); else await retained.source.pause(); }
                    catch (error) { throw sourceLifecycleError(error); }
                    if (retainedSources.get(id) === retained) retainedSources.delete(id);
                }
            };
            try { await complete(); }
            catch (error) {
                // Output is proven stopped, but an invalid source may need the
                // provider's final native recovery instead of another track hold.
                if ((!error?.sourceFailure && !['SOURCE_UNAVAILABLE', 'SOURCE_EXPIRED', 'SOURCE_RESTORE_UNCONFIRMED', 'CANCELLED',
                    'HELPER_RESTART_REQUIRED', 'FORMAT_LEASE_READBACK_MISMATCH'].includes(error?.code))
                    || blockedRelease && !blockedRelease.outputReleased) throw error;
                return { complete };
            }
        },
    };
}
module.exports = { registerNativeAudio };
