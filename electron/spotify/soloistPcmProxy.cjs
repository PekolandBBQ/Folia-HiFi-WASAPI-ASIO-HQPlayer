'use strict';
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');

// electron/spotify/soloistPcmProxy.cjs: main-owned, revocable single-reader PCM transport.
// The WAV describes prepared s32le PCM, never Spotify's original codec or bit depth.
const failed = code => Object.assign(new Error(code), { code });
const MAX_INPUT_CHUNK = 1024 * 1024;
const WRITE_CHUNK = 65536;
function waveHeader() {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(0xffffffff, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(44100, 24); header.writeUInt32LE(44100 * 8, 28);
    header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
    header.write('data', 36); header.writeUInt32LE(0xffffffff, 40);
    return header;
}
function createSoloistPcmProxy() {
    const entries = new Map();
    let starting, port, closing, closed = false;
    function release(entry, reason, destroyResponse = true) {
        if (entry.revoked) return entry.cleanup;
        entry.revoked = true; entries.delete(entry.key); entry.active = false;
        entry.controller.abort(); if (destroyResponse) entry.response?.destroy();
        if (!entry.natural) entry.rejectCompletion(failed(reason === 'producer-error' ? 'SOLOIST_PCM_SOURCE_FAILED' : 'SOLOIST_PCM_REVOKED'));
        // Do not await an iterator stuck in next(): owner-gated close must run now.
        if (entry.iterator?.return) void Promise.resolve().then(() => entry.iterator.return()).catch(() => {});
        entry.cleanup = Promise.resolve().then(() => entry.close({ reason }));
        void entry.cleanup.catch(() => {});
        return entry.cleanup;
    }
    async function stream(entry, req, res) {
        entry.claimed = true; entry.active = true; entry.response = res;
        const cancel = () => { if (!entry.natural && !entry.revoked) void release(entry, 'reader-cancelled'); };
        res.once('close', cancel); req.once('aborted', cancel);
        let pcmBytes = 0;
        try {
            const source = await entry.open({ signal: entry.controller.signal });
            if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw failed('SOLOIST_PCM_SOURCE_INVALID');
            entry.iterator = source[Symbol.asyncIterator]();
            if (entry.revoked) {
                if (entry.iterator.return) void Promise.resolve().then(() => entry.iterator.return()).catch(() => {});
                return;
            }
            res.writeHead(200);
            async function write(bytes) {
                if (entry.controller.signal.aborted || res.destroyed) throw failed('SOLOIST_PCM_REVOKED');
                // A producer may reuse its receive buffer after next(). Retain
                // only one bounded copy per write until the socket drains.
                if (!res.write(Buffer.from(bytes))) await once(res, 'drain', { signal: entry.controller.signal });
            }
            await write(waveHeader());
            while (!entry.controller.signal.aborted) {
                const next = await entry.iterator.next();
                if (entry.controller.signal.aborted) throw failed('SOLOIST_PCM_REVOKED');
                if (next.done) {
                    if (pcmBytes % 8 !== 0) throw failed('SOLOIST_PCM_FRAME_INVALID');
                    entry.natural = true; entry.active = false;
                    entry.resolveCompletion({ natural: true, bytes: pcmBytes });
                    res.end();
                    // Keep the source/control lease until explicit revoke or shutdown.
                    // Natural producer EOF must not pause/revoke the current song.
                    return;
                }
                const chunk = next.value;
                if (!Buffer.isBuffer(chunk) || chunk.length > MAX_INPUT_CHUNK) throw failed('SOLOIST_PCM_CHUNK_INVALID');
                pcmBytes += chunk.length;
                if (!Number.isSafeInteger(pcmBytes)) throw failed('SOLOIST_PCM_SOURCE_TOO_LARGE');
                for (let offset = 0; offset < chunk.length; offset += WRITE_CHUNK) {
                    await write(chunk.subarray(offset, Math.min(chunk.length, offset + WRITE_CHUNK)));
                }
            }
        } catch {
            if (!entry.revoked) {
                const beforeHeaders = !res.headersSent && !res.destroyed;
                if (beforeHeaders) res.writeHead(502).end();
                void release(entry, 'producer-error', !beforeHeaders);
            }
        } finally {
            entry.active = false;
            req.removeListener('aborted', cancel);
            res.removeListener('close', cancel);
        }
    }
    const server = http.createServer((req, res) => {
        if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
        const entry = entries.get(req.url);
        if (!entry || entry.revoked) { res.writeHead(404).end(); return; }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { res.writeHead(405).end(); return; }
        if (req.headers.origin) {
            let allowed = req.headers.origin === 'null';
            try { allowed ||= ['127.0.0.1', 'localhost'].includes(new URL(req.headers.origin).hostname); } catch {}
            if (!allowed) { res.writeHead(403).end(); return; }
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Accept-Ranges', 'none'); res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers.range && !/^bytes=0-(?:\d+)?$/.test(req.headers.range)) {
            res.writeHead(416).end(); return;
        }
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
        if (entry.claimed) { res.writeHead(409).end(); return; }
        void stream(entry, req, res);
    });
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    async function start() {
        if (closed) throw failed('SOLOIST_PCM_PROXY_CLOSED');
        if (!starting) starting = new Promise((resolve, reject) => {
            const error = () => reject(failed('SOLOIST_PCM_PROXY_UNAVAILABLE'));
            server.once('error', error);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', error); port = server.address().port; resolve();
            });
        });
        await starting;
        if (closed) throw failed('SOLOIST_PCM_PROXY_CLOSED');
    }
    async function clear() {
        const pending = [...entries.values()].map(entry => release(entry, 'revoked'));
        await Promise.all(pending);
    }
    return Object.freeze({
        async add({ open, close }) {
            if (typeof open !== 'function' || typeof close !== 'function') throw failed('SOLOIST_PCM_SOURCE_INVALID');
            await start();
            const key = `/${randomBytes(24).toString('hex')}.wav`;
            let resolveCompletion, rejectCompletion;
            const completed = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
            void completed.catch(() => {});
            const entry = { key, open, close, claimed: false, active: false, revoked: false, natural: false,
                controller: new AbortController(), resolveCompletion, rejectCompletion, cleanup: null, iterator: null, response: null };
            entries.set(key, entry);
            return Object.freeze({ url: `http://127.0.0.1:${port}${key}`, completed,
                activeReaders: () => entry.active ? 1 : 0,
                revoke: () => release(entry, 'revoked') });
        },
        clear,
        close() {
            if (closing) return closing;
            closed = true;
            closing = (async () => {
                if (starting) await starting.catch(() => {});
                let failure;
                try { await clear(); } catch (error) { failure = error; }
                if (server.listening) await new Promise((resolve, reject) => {
                    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
                });
                if (failure) throw failure;
            })();
            return closing;
        },
    });
}
module.exports = { createSoloistPcmProxy };
