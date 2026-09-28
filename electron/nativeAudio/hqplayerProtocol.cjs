const net = require('node:net');
const { EventEmitter } = require('node:events');
const { DOMParser } = require('@xmldom/xmldom');

// electron/nativeAudio/hqplayerProtocol.cjs — the documented HQPlayer 6 XML control connection.
const DEFAULT_PORT = 4321;
const COMMAND_TIMEOUT_MS = 8000;
const SOURCE_REJECTED_CODE = 'HQPLAYER_SOURCE_REJECTED';

function xmlEscape(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;');
}

function buildCommand(name, attributes = {}) {
    const serialized = Object.entries(attributes)
        .map(([key, value]) => ` ${key}="${xmlEscape(value)}"`).join('');
    return `<?xml version="1.0"?><${name}${serialized}/>`;
}

function numberAttribute(element, name, fallback = 0) {
    if (!element.hasAttribute(name)) return fallback;
    const value = Number(element.getAttribute(name));
    return Number.isFinite(value) ? value : fallback;
}

function parseDocument(xml) {
    const errors = [];
    const document = new DOMParser({
        onError: (level, message) => { if (level !== 'warning') errors.push(message); },
    }).parseFromString(xml, 'application/xml');
    if (errors.length || !document.documentElement) throw new Error(`Invalid HQPlayer response: ${errors[0] || 'empty XML'}`);
    return document.documentElement;
}

function parseStatus(element, previous = {}) {
    const stateCode = numberAttribute(element, 'state');
    const reportedDuration = numberAttribute(element, 'length');
    const duration = reportedDuration > 0 ? reportedDuration : Number(previous.duration) || 0;
    // `position` is the Control API's fractional playback clock. Desktop also exposes
    // `display_position`, but it advances only about once per second and is intended for UI text.
    const reportedPosition = Math.max(0, numberAttribute(element, 'position',
        numberAttribute(element, 'display_position', Number(previous.position) || 0)));
    const previousPosition = Math.max(0, Number(previous.position) || 0);
    const endTolerance = Math.max(1.25, (Number(previous.latency) || 0) + 0.25);
    const reachedEnd = duration > 0 && previousPosition >= duration - endTolerance;
    const previousTrackSerial = Math.max(0, Number(previous.trackSerial) || 0);
    const trackSerial = Math.max(0, numberAttribute(element, 'track_serial', previousTrackSerial));
    const hasTrackSerial = previousTrackSerial > 0 && trackSerial > 0;
    const naturallyAdvanced = hasTrackSerial ? trackSerial > previousTrackSerial : reachedEnd;
    // Both natural completion and the Desktop Stop button report state=0, position=0,
    // length=0. Natural completion advances track_serial; the position window is a fallback
    // for older versions that do not expose it.
    const ended = stateCode === 0 && Boolean(previous.playing) && naturallyAdvanced;
    const position = ended ? duration : reportedPosition;
    return {
        ...previous,
        position: duration > 0 ? Math.min(position, duration) : position,
        duration,
        playing: stateCode === 2,
        ended,
        trackSerial,
        sampleRate: numberAttribute(element, 'active_rate', Number(previous.sampleRate) || 0),
        outputRateReported: element.hasAttribute('active_rate') && numberAttribute(element, 'active_rate') > 0,
        outputMode: element.getAttribute('active_mode') || undefined,
        channels: numberAttribute(element, 'active_channels', Number(previous.channels) || 0),
        latency: Math.max(0, numberAttribute(element, 'output_delay') / 1_000_000),
        volumeDb: numberAttribute(element, 'volume', Number(previous.volumeDb) || 0),
        outputFormat: [element.getAttribute('active_mode'), element.getAttribute('active_filter')]
            .filter(Boolean).join(' · '),
    };
}

function parsePlaylistItem(element) {
    const item = Array.from(element.getElementsByTagName('PlaylistItem'))[0];
    if (!item) {
        const error = new Error('HQPlayer did not accept the prepared audio file');
        error.code = SOURCE_REJECTED_CODE;
        throw error;
    }
    return {
        duration: numberAttribute(item, 'length'), sampleRate: numberAttribute(item, 'rate'),
        channels: numberAttribute(item, 'channels'), bits: numberAttribute(item, 'bits'),
    };
}

class HQPlayerProtocol extends EventEmitter {
    constructor({ host = '127.0.0.1', port = DEFAULT_PORT, connectTimeoutMs = 1500 } = {}) {
        super();
        this.host = host; this.port = port; this.connectTimeoutMs = connectTimeoutMs;
        this.socket = null; this.buffer = ''; this.waiters = [];
    }

    async connect() {
        if (this.socket && !this.socket.destroyed) return;
        await new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('HQPlayer control connection timed out')); },
                this.connectTimeoutMs);
            socket.setNoDelay(true); socket.setKeepAlive(true, 5000);
            socket.once('connect', () => { clearTimeout(timer); this.socket = socket; this.bindSocket(socket); resolve(); });
            socket.once('error', error => { clearTimeout(timer); reject(error); });
        });
    }

    isConnected() { return Boolean(this.socket && !this.socket.destroyed); }

    bindSocket(socket) {
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', error => this.fail(error));
        socket.on('close', () => {
            if (this.socket !== socket) return;
            this.socket = null; this.fail(new Error('HQPlayer control connection closed'));
        });
    }

    receive(chunk) {
        this.buffer += chunk.toString('utf8');
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let root;
            try { root = parseDocument(line); } catch (error) { this.emit('error', error); continue; }
            if (root.tagName === 'Status' && (!root.getAttribute('result') || root.getAttribute('result') === 'OK'))
                this.emit('status', root);
            const index = this.waiters.findIndex(waiter => waiter.name === root.tagName);
            if (index < 0) continue;
            const waiter = this.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer);
            const result = root.getAttribute('result');
            if (result && result !== 'OK') {
                const error = new Error(`HQPlayer ${root.tagName} failed: ${result}`);
                error.code = 'HQPLAYER_COMMAND_REJECTED'; error.command = root.tagName; error.result = result;
                waiter.reject(error);
            }
            else waiter.resolve(root);
        }
    }

    request(name, attributes = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
        if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('HQPlayer is not connected'));
        return new Promise((resolve, reject) => {
            const waiter = { name, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
                reject(new Error(`HQPlayer ${name} response timed out`));
            }, timeoutMs);
            this.waiters.push(waiter);
            this.socket.write(`${buildCommand(name, attributes)}\n`);
        });
    }

    send(name, attributes = {}) {
        if (!this.socket || this.socket.destroyed) throw new Error('HQPlayer is not connected');
        this.socket.write(`${buildCommand(name, attributes)}\n`);
    }

    fail(error) {
        for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
        this.emit('error', error);
    }

    close() {
        const socket = this.socket; this.socket = null;
        if (socket && !socket.destroyed) socket.destroy();
        this.fail(new Error('HQPlayer control connection closed'));
    }
}

module.exports = { HQPlayerProtocol, buildCommand, parseDocument, parsePlaylistItem, parseStatus,
    DEFAULT_PORT, SOURCE_REJECTED_CODE };
