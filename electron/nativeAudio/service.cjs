const fs = require('node:fs/promises');
const path = require('node:path');
const { createHelper } = require('./helper.cjs');
const { decodeLocalAudio } = require('./decode.cjs');
const { downloadRemoteAudio } = require('./download.cjs');
const { audioError, errorCode, diagnostic } = require('./errors.cjs');
const { createHQPlayerComponentHost } = require('../hqplayer/client.cjs');
const { loadHQPlayerSession } = require('./hqplayerSession.cjs');

// electron/nativeAudio/service.cjs — a single, session-owned local playback resource.
function registerNativeAudio({ app, ipcMain, isTrustedSender, helperFactory = createHelper, decode = decodeLocalAudio, download = downloadRemoteAudio, componentManager, hqplayerFactory = createHQPlayerComponentHost, chooseHQPlayerExecutable, decoderResolver = require('./decoder.cjs').resolveNativeDecoder }) {
    const supported = process.platform === 'win32' && process.arch === 'x64';
    const components = componentManager || require('./componentManager.cjs').createComponentManager({ app });
    let active = null, helper = null, helperReady = null, decoder, managingComponent = false;
    let nativeHandoffPending = false;
    const hqplayer = hqplayerFactory({
        app,
        configPath: path.join(app.getPath('userData'), 'hqplayer.json'),
        onState: state => {
            const current = active;
            if (!current || current.backend !== 'hqplayer' || current.id !== state.session || current.sender.isDestroyed()) return;
            current.sender.send('native-audio:event', { event: 'state', session: current.id, state: { ...state, ...current.sourceInfo } });
        },
        onError: error => {
            diagnostic(error);
            const current = active;
            if (!current || current.backend !== 'hqplayer' || current.sender.isDestroyed()) return;
            current.sender.send('native-audio:event', { event: 'error', session: current.id, errorCode: errorCode(error) });
        },
    });
    async function ensureHelper() {
        if (helperReady) return helperReady;
        helperReady = (async () => {
            const installed = await components.status();
            if (!installed.available) throw audioError(installed.errorCode || 'COMPONENT_UNAVAILABLE', installed.error || 'Install a compatible native audio component first');
            decoder = await decoderResolver(app);
            helper = helperFactory(installed.executable, event => {
                if (event.event === 'error' && !event.session) helperReady = null;
                const current = active;
                if (!current || current.backend === 'hqplayer' || current.sender.isDestroyed()) return;
                if ((event.session || event.state?.session) && (event.session || event.state.session) !== current.id) return;
                current.sender.send('native-audio:event', { ...event, state: event.state ? { ...event.state, ...current.sourceInfo } : undefined, session: current.id });
            });
            const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
            if (hello.protocolMajor !== 1 || !['integer-pcm', 'replaygain', 'format-telemetry'].every(capability => hello.capabilities?.includes(capability))
                || (installed.version && hello.componentVersion !== installed.version)) {
                helper?.dispose(); helper = null;
                throw audioError('COMPONENT_INCOMPATIBLE', 'Unsupported native audio component protocol or capabilities');
            }
            return helper;
        })().catch(error => { helperReady = null; throw error; });
        return helperReady;
    }

    function progress(current, stage, values = {}) {
        if (active !== current || current.abort.signal.aborted || current.sender.isDestroyed()) return;
        const now = Date.now();
        if (current.stage !== stage) {
            console.info('[PlaybackPreparation]', { session: current.id, stage, previousStage: current.stage, elapsedMs: now - current.startedAt });
            current.stage = stage;
        }
        current.sender.send('native-audio:event', { event: 'progress', session: current.id,
            progress: { stage, elapsedMs: now - current.startedAt, ...values } });
    }
    function assertCurrent(session) {
        if (active !== session || session.abort.signal.aborted) throw audioError('CANCELLED', 'Playback request was cancelled');
    }
    async function release(session) {
        if (!session) return;
        session.abort.abort();
        if (session.backend === 'hqplayer') await hqplayer.stop(session.id).catch(() => {});
        else if (session.loadRequested) await helper?.request({ action: 'stop', session: session.id }).catch(() => {});
        await session.decoding?.catch(() => {});
        await session.creating?.catch(() => {});
        if (session.directory) await fs.rm(session.directory, { recursive: true, force: true }).catch(() => {});
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
        const previous = active;
        const current = { id: request.session, sender, abort: new AbortController(), directory: null,
            backend: request.backend, deviceId: request.deviceId, processingMode, hqplayerGainDb, hqplayerDefaults: request.hqplayerDefaults, compatibilityMode: request.compatibilityMode === true, trackKey: request.trackKey, sourceName: request.sourceName, sourceMimeType: request.mimeType, startedAt: Date.now(), bytes: 0, ready: false };
        active = current;
        await release(previous);
        assertCurrent(current);
        progress(current, current.backend === 'hqplayer' ? 'connect' : 'load');
        if (current.backend === 'hqplayer') {
            // Connect while staging the source; native HQPlayer formats do not need FFmpeg.
            await hqplayer.checkExisting?.();
            assertCurrent(current);
            hqplayer.setSilent?.(request.silent === true);
            current.connection = hqplayer.prepare?.().then(() => null, error => error);
        } else await ensureHelper();
        assertCurrent(current);
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
        if (request?.action === 'hqplayer-window') return require('./hqplayerWindow.cjs').hqplayerWindow(request.visible);
        if (request?.action === 'hqplayer-shutdown') {
            if (active?.backend === 'hqplayer') { const previous = active; active = null; await release(previous); }
            await hqplayer.shutdown();
            nativeHandoffPending = true;
            // A DSD driver mode change can invalidate COM endpoints in a previously enumerating host.
            // Recreate the idle driver process before the next native backend is opened.
            if (!active) { await helperReady?.catch(() => {}); helper?.dispose(); helper = null; helperReady = null; }
            return { ok: true };
        }
        if (['hqplayer-component-install', 'hqplayer-component-uninstall', 'hqplayer-component-rollback'].includes(request?.action)) {
            if (active?.backend === 'hqplayer') throw audioError('INVALID_REQUEST', 'Switch away from HQPlayer before managing its component');
            return hqplayer.manage(request.action.slice('hqplayer-component-'.length));
        }
        if (request?.action === 'hqplayer-authorize-existing') return hqplayer.authorizeExisting(request.instancePid);
        if (request?.action === 'hqplayer-launch-options') { hqplayer.setSilent(request.silent === true); return { ok: true }; }
        if (request?.action === 'hqplayer-dsp-read') return hqplayer.dspSettings();
        if (request?.action === 'hqplayer-dsp-apply') {
            if (active && active.sender !== event.sender) throw audioError('INVALID_REQUEST');
            if (request.when === 'current' && (!active?.ready || active.backend !== 'hqplayer')) throw audioError('INVALID_REQUEST');
            const result = await hqplayer.dspSettings(request.settings, request.when, request.session);
            if (request.when === 'current' && active?.id === result.session && active.sender === event.sender) {
                // Only this explicit user action may resume a paused renderer transport.
                event.sender.send('native-audio:event', { event: 'resume', session: result.session, state: { ...result, ...active.sourceInfo } });
            }
            return result;
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
            if (active || managingComponent) throw new Error('Switch to browser playback and wait for any component operation to finish');
            managingComponent = true;
            helper?.dispose(); helper = null; helperReady = null;
            try { await (request.action === 'component-install' ? components.install() : request.action === 'component-rollback' ? components.rollback() : components.uninstall()); }
            catch (error) { throw error.code ? error : audioError('COMPONENT_UPDATE_FAILED', error.message); }
            finally { managingComponent = false; }
            return { ok: true };
        }
        if (request?.action === 'devices') return (await ensureHelper()).request({ action: 'devices' });
        if (request?.action === 'begin') return begin(request, event.sender);
        const current = active;
        // Disposal can race StrictMode remounts or a newer source. A stale stop is a no-op,
        // never permission to stop whichever track happens to own the driver now.
        if (request?.action === 'stop' && (!current || request.session !== current.id)) return { ok: true };
        if (!current || request?.session !== current.id || event.sender !== current.sender) throw audioError('CANCELLED', 'Stale playback session');
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
                if (current.remoteUrl) {
                    const sessionFetch = current.sender.session?.fetch?.bind(current.sender.session);
                    if (!sessionFetch && download === downloadRemoteAudio) throw audioError('SOURCE_UNAVAILABLE', 'Electron session fetch is unavailable');
                    progress(current, 'download');
                    const downloaded = await download(current.remoteUrl, current.input, current.abort.signal, sessionFetch, values => progress(current, 'download', values));
                    if (downloaded?.contentType) current.sourceMimeType = downloaded.contentType;
                }
                assertCurrent(current);
                progress(current, 'inspect');
                current.sourceInfo = await require('./sourceInfo.cjs').readSourceInfo(current.input);
                assertCurrent(current);
                if (current.backend === 'hqplayer') {
                    progress(current, 'connect');
                    const connectionError = await current.connection;
                    if (connectionError) throw connectionError;
                    assertCurrent(current);
                    progress(current, 'load');
                    const result = await loadHQPlayerSession({ current, hqplayer, decoder, resolveDecoder: () => decoderResolver(app), decode, assertCurrent, onProgress: stage => progress(current, stage) });
                    assertCurrent(current); current.ready = true;
                    return { ...result, ...current.sourceInfo };
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
                return { ...result, ...current.sourceInfo };
            })();
            return current.decoding;
        }
        if (request.action === 'stop') {
            active = null;
            await release(current);
            return { ok: true };
        }
        const actions = current.backend === 'hqplayer' ? ['play', 'pause', 'seek', 'volume', 'replaygain', 'gain'] : ['play', 'pause', 'seek', 'volume', 'replaygain'];
        if (!current.ready || !actions.includes(request.action)) throw new Error('Audio is not ready');
        if (request.action === 'seek' && (!Number.isFinite(request.position) || request.position < 0)) throw new Error('Invalid seek');
        if (request.action === 'volume' && (!Number.isFinite(request.volume) || request.volume < 0 || request.volume > 1)) throw new Error('Invalid volume');
        if (request.action === 'replaygain' && (!Number.isFinite(request.gain) || request.gain < 0 || request.gain > 16)) throw new Error('Invalid ReplayGain');
        if (current.backend === 'hqplayer') {
            if (request.action === 'gain' && (!Number.isFinite(request.gainDb) || request.gainDb < -120 || request.gainDb > 0)) throw audioError('INVALID_REQUEST', 'Invalid HQPlayer gain');
            const value = request.action === 'seek' ? request.position : request.action === 'volume' ? request.volume : request.action === 'replaygain' ? request.gain : request.gainDb;
            return { ...await hqplayer.command(current.id, request.action, value), ...current.sourceInfo };
        }
        return { ...await helper.request({ action: request.action, session: current.id, position: request.position, volume: request.volume, gain: request.gain }), ...current.sourceInfo };
    }
    ipcMain.handle('native-audio:request', async (event, request) => {
        try { return await handle(event, request); }
        catch (error) { diagnostic(error); return { nativeAudioError: { code: errorCode(error) } }; }
    });
    app.on('web-contents-created', (_, contents) => {
        const stop = () => { if (active?.sender === contents) { const previous = active; active = null; void release(previous); } };
        contents.on('destroyed', stop);
        contents.on('render-process-gone', stop);
        contents.on('did-start-navigation', (_, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) stop(); });
    });
    app.on('before-quit', () => {
        const previous = active; active = null;
        previous?.abort.abort(); helper?.dispose(); hqplayer.dispose();
        if (previous) void Promise.resolve(previous.decoding).catch(() => {}).then(() =>
            previous.directory && fs.rm(previous.directory, { recursive: true, force: true }).catch(() => {}));
    });
    return { handle };
}
module.exports = { registerNativeAudio };
