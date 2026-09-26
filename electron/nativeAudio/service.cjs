const fs = require('node:fs/promises');
const path = require('node:path');
const { createHelper } = require('./helper.cjs');
const { decodeLocalAudio } = require('./decode.cjs');
const { downloadRemoteAudio } = require('./download.cjs');

// electron/nativeAudio/service.cjs — a single, session-owned local playback resource.
function registerNativeAudio({ app, ipcMain, isTrustedSender, helperFactory = createHelper, decode = decodeLocalAudio, download = downloadRemoteAudio, componentManager, decoderResolver = require('./decoder.cjs').resolveNativeDecoder }) {
    const supported = process.platform === 'win32' && process.arch === 'x64';
    const components = componentManager || require('./componentManager.cjs').createComponentManager({ app });
    let active = null, helper = null, helperReady = null, decoder, managingComponent = false;
    async function ensureHelper() {
        if (helperReady) return helperReady;
        helperReady = (async () => {
            const installed = await components.status();
            if (!installed.available) throw new Error(installed.error || 'Install a compatible native audio component first');
            decoder = await decoderResolver(app);
            helper = helperFactory(installed.executable, event => {
                if (event.event === 'error' && !event.session) helperReady = null;
                const current = active;
                if (!current || current.sender.isDestroyed()) return;
                if ((event.session || event.state?.session) && (event.session || event.state.session) !== current.id) return;
                current.sender.send('native-audio:event', { ...event, state: event.state ? { ...event.state, ...current.sourceInfo } : undefined, session: current.id });
            });
            const hello = await helper.request({ action: 'hello', protocolMajor: 1 });
            if (hello.protocolMajor !== 1 || !['integer-pcm', 'replaygain', 'format-telemetry'].every(capability => hello.capabilities?.includes(capability))
                || (installed.version && hello.componentVersion !== installed.version)) {
                helper?.dispose(); helper = null;
                throw new Error('Unsupported native audio component protocol or capabilities');
            }
            return helper;
        })().catch(error => { helperReady = null; throw error; });
        return helperReady;
    }

    function assertCurrent(session) {
        if (active !== session || session.abort.signal.aborted) throw new Error('Playback request was cancelled');
    }
    async function release(session) {
        if (!session) return;
        session.abort.abort();
        await helper?.request({ action: 'stop', session: session.id }).catch(() => {});
        await session.decoding?.catch(() => {});
        await session.creating?.catch(() => {});
        if (session.directory) await fs.rm(session.directory, { recursive: true, force: true }).catch(() => {});
    }
    // Claim before any await; a superseded decoder or upload can never load over the new song.
    async function begin(request, sender) {
        if (managingComponent) throw new Error('Component operation is in progress');
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(request.session || '')) throw new Error('Invalid session');
        if (!['wasapi-exclusive', 'asio'].includes(request.backend) || typeof request.deviceId !== 'string' || !request.deviceId)
            throw new Error('Select an output device');
        if (request.path != null && (typeof request.path !== 'string' || !path.isAbsolute(request.path) || request.path.startsWith('\\\\')))
            throw new Error('Only local absolute file paths are supported');
        if (request.path != null && request.url != null) throw new Error('Choose one audio source');
        if (request.url != null) {
            if (typeof request.url !== 'string' || request.url.length > 16384) throw new Error('Invalid audio URL');
            const url = new URL(request.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) audio URLs are supported');
        }
        const processingMode = request.processingMode ?? 'compatibility';
        if (!['compatibility', 'integer-direct'].includes(processingMode)) throw new Error('Invalid processing mode');
        const previous = active;
        const current = { id: request.session, sender, abort: new AbortController(), directory: null,
            backend: request.backend, deviceId: request.deviceId, processingMode, bytes: 0, ready: false };
        active = current;
        await release(previous);
        assertCurrent(current);
        await ensureHelper();
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
            if (state.available) try { await decoderResolver(app); } catch (error) { decoderError = error.message; }
            const { executable, ...publicState } = state;
            return { ...publicState, supported, available: state.available && !decoderError, error: decoderError || state.error };
        }
        if (!supported) throw new Error('Native playback requires Windows x64');
        if (['component-install', 'component-uninstall'].includes(request?.action)) {
            if (active || managingComponent) throw new Error('Switch to browser playback and wait for any component operation to finish');
            managingComponent = true;
            helper?.dispose(); helper = null; helperReady = null;
            try { await (request.action === 'component-install' ? components.install() : components.uninstall()); }
            finally { managingComponent = false; }
            return { ok: true };
        }
        if (request?.action === 'devices') return (await ensureHelper()).request({ action: 'devices' });
        if (request?.action === 'begin') return begin(request, event.sender);
        const current = active;
        // Disposal can race StrictMode remounts or a newer source. A stale stop is a no-op,
        // never permission to stop whichever track happens to own the driver now.
        if (request?.action === 'stop' && (!current || request.session !== current.id)) return { ok: true };
        if (!current || request?.session !== current.id || event.sender !== current.sender) throw new Error('Stale playback session');
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
                if (current.remoteUrl) await download(current.remoteUrl, current.input, current.abort.signal);
                assertCurrent(current);
                current.sourceInfo = await require('./sourceInfo.cjs').readSourceInfo(current.input);
                assertCurrent(current);
                const wav = await decode(decoder, current.input, current.directory, current.abort.signal, current.processingMode);
                assertCurrent(current);
                const result = await helper.request({ action: 'load', session: current.id, path: wav,
                    backend: current.backend, deviceId: current.deviceId, processingMode: current.processingMode });
                assertCurrent(current);
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
        if (!current.ready || !['play', 'pause', 'seek', 'volume', 'replaygain'].includes(request.action)) throw new Error('Audio is not ready');
        if (request.action === 'seek' && (!Number.isFinite(request.position) || request.position < 0)) throw new Error('Invalid seek');
        if (request.action === 'volume' && (!Number.isFinite(request.volume) || request.volume < 0 || request.volume > 1)) throw new Error('Invalid volume');
        if (request.action === 'replaygain' && (!Number.isFinite(request.gain) || request.gain < 0 || request.gain > 16)) throw new Error('Invalid ReplayGain');
        return { ...await helper.request({ action: request.action, session: current.id, position: request.position, volume: request.volume, gain: request.gain }), ...current.sourceInfo };
    }
    ipcMain.handle('native-audio:request', handle);
    app.on('web-contents-created', (_, contents) => {
        const stop = () => { if (active?.sender === contents) { const previous = active; active = null; void release(previous); } };
        contents.on('destroyed', stop);
        contents.on('render-process-gone', stop);
        contents.on('did-start-navigation', (_, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) stop(); });
    });
    app.on('before-quit', () => {
        const previous = active; active = null;
        previous?.abort.abort(); helper?.dispose();
        if (previous) void Promise.resolve(previous.decoding).catch(() => {}).then(() =>
            previous.directory && fs.rm(previous.directory, { recursive: true, force: true }).catch(() => {}));
    });
    return { handle };
}
module.exports = { registerNativeAudio };
