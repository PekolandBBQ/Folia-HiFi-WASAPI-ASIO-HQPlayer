const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findHQPlayerExecutable, validExecutable, isDesktopName, createExecutablePreference } = require('./hqplayerDiscovery.cjs');
const { audioError } = require('./errors.cjs');
const { HQPlayerProtocol, parsePlaylistItem, parseStatus, DEFAULT_PORT } = require('./hqplayerProtocol.cjs');

// electron/nativeAudio/hqplayerHost.cjs — installation discovery, background startup and playback ownership.
const execFileAsync = promisify(execFile);
const DEVICE_ID = 'hqplayer-local';
const START_TIMEOUT_MS = 20000;
const PLAYLIST_TIMEOUT_MS = 5000;

async function canConnect(port = DEFAULT_PORT) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

async function startMinimized(executable, { exec = execFileAsync } = {}) {
    if (!executable || !isDesktopName(executable))
        throw audioError('HQPLAYER_UNAVAILABLE', 'HQPlayer Desktop executable was not found');
    const encoded = Buffer.from(executable, 'utf8').toString('base64');
    const script = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FOLIA_HQP_PATH));"
        + "$x=Start-Process -FilePath $p -WorkingDirectory (Split-Path -Parent $p) -WindowStyle Hidden -PassThru;"
        + "[Console]::Out.Write($x.Id)";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 8000, encoding: 'utf8', env: { ...process.env, FOLIA_HQP_PATH: encoded },
    });
    const pid = Number(stdout.trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('HQPlayer Desktop did not start');
    return pid;
}

async function waitForServer(timeoutMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', 'HQPlayer Control API did not become ready; check Allow control from network');
}

function volumeToDb(volume) {
    return volume <= 0 ? -120 : Math.max(-120, 20 * Math.log10(Math.min(1, volume)));
}

function clampGainDb(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(-120, Math.min(0, numeric)) : -2;
}

async function waitForPlaylistItem(client, timeoutMs = PLAYLIST_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    do {
        try { return parsePlaylistItem(await client.request('PlaylistGet')); }
        catch (error) {
            if (error?.code !== 'HQPLAYER_SOURCE_REJECTED') throw error;
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw lastError;
}

// Retry only explicit cold-connection rejections; a timed-out add may already have executed.
async function addPreparedPlaylist(client, filePath, coldConnection, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    const attempts = coldConnection ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await client.request('PlaylistAdd', { uri: filePath, queued: 0, clear: 1, start: 0, freewheel: 1 });
            return;
        } catch (error) {
            if (error?.code !== 'HQPLAYER_COMMAND_REJECTED' || error.command !== 'PlaylistAdd'
                || error.result !== 'Error' || attempt === attempts - 1) throw error;
            await delay(500 * (attempt + 1));
        }
    }
}

function createHQPlayerHost({ protocolFactory = options => new HQPlayerProtocol(options), discover = findHQPlayerExecutable,
    launch = startMinimized, probe = canConnect, wait = waitForServer, kill = pid => process.kill(pid),
    onState = () => {}, onError = () => {}, configPath } = {}) {
    const preference = createExecutablePreference(configPath);
    let protocol = null; let executable = null; let launchedPid = null; let pollTimer = null;
    let coldConnection = true;
    let expectedVolumeDb = -2, volumeWriteUntil = 0;
    let pendingSeek = null;
    let active = null; let queue = Promise.resolve(); let awaitingPlayingUntil = 0;

    async function device() {
        const running = await probe();
        const custom = await preference.read();
        executable = custom ? await validExecutable(custom) ? custom : null : await discover();
        return running || executable ? { backend: 'hqplayer', id: DEVICE_ID, name: 'HQPlayer Desktop' } : null;
    }

    async function connect() {
        if (protocol?.isConnected()) return protocol;
        const previous = protocol; protocol = null; previous?.close();
        clearInterval(pollTimer); pollTimer = null;
        if (!await probe()) {
            await device();
            try { launchedPid = await launch(executable); }
            catch (error) { throw error.code === 'HQPLAYER_UNAVAILABLE' ? error : audioError('HQPLAYER_CONTROL_UNAVAILABLE', error.message); }
            await wait();
        }
        const next = protocolFactory();
        next.on('status', element => {
            if (!active || !element.hasAttribute('state')
                || (element.getAttribute('result') && element.getAttribute('result') !== 'OK')) return;
            const stateCode = Number(element.getAttribute('state'));
            // Poll replies already in flight can arrive after Seek's acknowledgement.
            // Wait for the requested position, with a bound so a failed seek cannot hide a real stop forever.
            if (pendingSeek) {
                const position = Number(element.getAttribute('position'));
                if (stateCode !== 0 && element.hasAttribute('position') && Math.abs(position - pendingSeek.position) < 1)
                    pendingSeek = null;
                else if (Date.now() < pendingSeek.until) return;
                else pendingSeek = null;
            }
            if (stateCode === 0 && Date.now() < awaitingPlayingUntil) return;
            if (stateCode === 2) awaitingPlayingUntil = 0;
            active = parseStatus(element, active);
            if (Date.now() >= volumeWriteUntil && Math.abs(active.volumeDb - expectedVolumeDb) > 0.05
                && active.masterVolume > 0 && (active.replayGain ?? 1) > 0) {
                active.hqplayerGainDb = clampGainDb(active.volumeDb - volumeToDb(active.masterVolume) - 20 * Math.log10(active.replayGain ?? 1));
                expectedVolumeDb = active.volumeDb;
            }
            onState({ ...active });
        });
        next.on('error', error => {
            if (protocol === next && !next.isConnected()) {
                protocol = null; clearInterval(pollTimer); pollTimer = null;
            }
            if (active) onError(audioError('HQPLAYER_CONTROL_UNAVAILABLE', error.message));
        });
        try { await next.connect(); } catch (error) { next.close(); throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', error.message); } protocol = next; coldConnection = true;
        next.send('Status', { subscribe: 1 });
        pollTimer = setInterval(() => {
            try { next.send('Status', { subscribe: 0 }); } catch (error) { if (active) onError(error); }
        }, 200);
        pollTimer.unref?.();
        return next;
    }

    function serialize(operation) {
        const result = queue.catch(() => {}).then(operation); queue = result; return result;
    }

    async function load({ session, filePath, gainDb = -2 }) {
        return serialize(async () => {
            const client = await connect();
            active = null; pendingSeek = null; awaitingPlayingUntil = 0;
            await client.request('Stop').catch(() => {});
            const retryColdConnection = coldConnection; coldConnection = false;
            await addPreparedPlaylist(client, filePath, retryColdConnection);
            const playlist = await waitForPlaylistItem(client);
            const hqplayerGainDb = clampGainDb(gainDb);
            expectedVolumeDb = hqplayerGainDb; volumeWriteUntil = Date.now() + 500;
            await client.request('Volume', { value: hqplayerGainDb });
            active = { session, position: 0, duration: playlist.duration, playing: false, ended: false,
                sampleRate: playlist.sampleRate, channels: playlist.channels, latency: 0,
                sourceSampleRate: playlist.sampleRate, sourceBitsPerSample: playlist.bits,
                outputRateReported: false,
                backend: 'hqplayer', deviceId: DEVICE_ID, outputFormat: `Source PCM${playlist.bits}`,
                hqplayerGainDb, volumeDb: hqplayerGainDb, masterVolume: 1, replayGain: 1 };
            awaitingPlayingUntil = 0;
            return { ...active };
        });
    }

    async function command(session, action, value) {
        return serialize(async () => {
            if (!active || active.session !== session) throw new Error('Stale HQPlayer playback session');
            const client = await connect();
            if (action === 'play') {
                if (active.ended) { await client.request('Seek', { position: 0 }); active.position = 0; active.ended = false; }
                awaitingPlayingUntil = Date.now() + 1500;
                await client.request('Play', { last: 0 }); active.playing = true;
            } else if (action === 'pause') {
                awaitingPlayingUntil = 0; await client.request('Pause'); active.playing = false;
            } else if (action === 'seek') {
                const position = Math.max(0, Math.round(value));
                pendingSeek = { position, until: Date.now() + 2000 + active.latency * 1000 };
                try { await client.request('Seek', { position }); } catch (error) { pendingSeek = null; throw error; }
                active.position = Math.max(0, Math.min(active.duration || value, value)); active.ended = false;
            } else if (action === 'volume') {
                active.masterVolume = Math.max(0, Math.min(1, value));
                active.volumeDb = clampGainDb(active.hqplayerGainDb + (active.masterVolume * (active.replayGain ?? 1) > 0 ? 20 * Math.log10(active.masterVolume * (active.replayGain ?? 1)) : -120));
                expectedVolumeDb = active.volumeDb; volumeWriteUntil = Date.now() + 500;
                await client.request('Volume', { value: active.volumeDb });
            } else if (action === 'replaygain') {
                active.replayGain = Math.max(0, Math.min(16, value));
                active.volumeDb = clampGainDb(active.hqplayerGainDb + (active.masterVolume * active.replayGain > 0 ? 20 * Math.log10(active.masterVolume * active.replayGain) : -120));
                expectedVolumeDb = active.volumeDb; volumeWriteUntil = Date.now() + 500;
                await client.request('Volume', { value: active.volumeDb });
            } else if (action === 'gain') {
                active.hqplayerGainDb = clampGainDb(value);
                active.volumeDb = clampGainDb(active.hqplayerGainDb + (active.masterVolume * (active.replayGain ?? 1) > 0 ? 20 * Math.log10(active.masterVolume * (active.replayGain ?? 1)) : -120));
                expectedVolumeDb = active.volumeDb; volumeWriteUntil = Date.now() + 500;
                await client.request('Volume', { value: active.volumeDb });
            }
            return { ...active };
        });
    }

    async function stop(session) {
        return serialize(async () => {
            if (!active || active.session !== session) return;
            const client = protocol;
            active = null; awaitingPlayingUntil = 0;
            await client?.request('Stop').catch(() => {});
        });
    }

    function dispose() {
        clearInterval(pollTimer); pollTimer = null; active = null; awaitingPlayingUntil = 0;
        const previous = protocol; protocol = null; previous?.close();
        if (launchedPid) { try { kill(launchedPid); } catch {} launchedPid = null; }
    }

    async function configuration() {
        const available = Boolean(await device());
        const custom = await preference.read();
        return { available, executablePath: custom || executable || '', custom: Boolean(custom),
            errorCode: !available && custom ? 'HQPLAYER_PATH_INVALID' : undefined };
    }
    async function configure(executablePath) {
        // Configuration is serialized after the service releases any active HQPlayer session.
        return serialize(async () => { await preference.set(executablePath); dispose(); executable = null; return configuration(); });
    }
    return { device, load, command, stop, dispose, configure, configuration };
}

module.exports = { createHQPlayerHost, findHQPlayerExecutable, startMinimized, volumeToDb, clampGainDb,
    waitForPlaylistItem, addPreparedPlaylist, DEVICE_ID };
