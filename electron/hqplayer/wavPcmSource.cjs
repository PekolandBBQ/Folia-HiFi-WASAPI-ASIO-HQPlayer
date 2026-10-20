const http = require('node:http');
const { WavReplayStore } = require('./wavReplayStore.cjs');
const { wavHttpRange } = require('./wavHttpRange.cjs');
const { wavHeader, liveDataLimit, HEADER_BYTES } = require('./wavHeader.cjs');
const { wavHttpAddress } = require('./wavHttpAddress.cjs');

// electron/hqplayer/wavPcmSource.cjs — unchanged signed PCM, replayable HTTP readers, and explicit live/complete lengths.
function createWavPcmSource(PcmLoopbackSource) {
    return class WavPcmSource extends PcmLoopbackSource {
        constructor(settings) {
            super(settings);
            if (this.format !== 'int32le') throw new Error('WAV input requires the existing signed PCM32 samples');
            this.inputContainer = 'wav';
            this.store = new WavReplayStore(); this.readers = new Set(); this.requestSequence = 0;
            this.limit = liveDataLimit(this.channels); this.highWaterRead = 0;
            this.onDiagnostic = settings.onDiagnostic || (() => {});
        }
        log(phase, facts = {}) { try { this.onDiagnostic({ event: 'wav-http', phase, sourceSession: this.session, ...facts }); } catch {} }
        get state() {
            return { session: this.session, queuedBytes: Math.max(0, this.store.bytes - this.highWaterRead),
                capacityBytes: this.limit, queuedSeconds: Math.max(0, this.store.bytes - this.highWaterRead) / this.byteRate,
                sentBytes: this.highWaterRead, producerComplete: this.finished, closed: this.closed,
                reading: this.readers.size > 0, socketBufferedBytes: Math.max(0, ...[...this.readers].map(r => r.writableLength || 0)) };
        }
        async write(chunk, session = this.session) {
            this.check(session);
            if (this.finished || this.writePending || !Buffer.isBuffer(chunk) || !chunk.length || chunk.length % this.alignment
                || chunk.length > this.maximumChunkBytes) throw new Error('Invalid or concurrent PCM write');
            if (this.store.bytes + chunk.length > this.limit) throw Object.assign(Error('实时 WAV 已达到 RIFF 容量上限，需要建立新会话'), { code: 'DECODE_FAILED' });
            this.writePending = true;
            try { await this.store.append(Buffer.from(chunk)); this.check(session); this.wake(); }
            catch (error) { this.log('producer-error', { code: error.code || 'WAV_CACHE_WRITE_FAILED', capturedBytes: this.store.bytes }); throw error; }
            finally { this.writePending = false; }
        }
        end(session = this.session) {
            this.check(session);
            if (this.writePending) throw new Error('Await the pending PCM write before completing');
            this.finished = true; this.wake();
            this.log('producer-complete', { capturedBytes: this.store.bytes, fileBytes: this.store.bytes + HEADER_BYTES, lengthKind: 'exact' });
        }
        async readResponse(response, selection, header, requestId, facts) {
            let offset = selection.start;
            try {
                while (!this.closed && !response.destroyed) {
                    const available = this.store.bytes + header.length;
                    const end = Math.min(selection.end ?? Infinity, available - 1);
                    if (offset <= end) {
                        const bytes = offset < header.length ? header.subarray(offset, Math.min(header.length, end + 1))
                            : await this.store.read(offset - header.length, Math.min(this.maximumChunkBytes, end - offset + 1));
                        if (response.destroyed || this.closed) break;
                        if (!bytes.length) throw new Error('WAV cache read made no progress');
                        offset += bytes.length; facts.sentBytes += bytes.length;
                        if (selection.status === 200) this.highWaterRead = Math.max(this.highWaterRead, offset - header.length, 0);
                        if (!response.write(bytes)) while (response.writableNeedDrain && !response.destroyed && !this.closed) await this.changed();
                        continue;
                    }
                    if ((selection.end !== null && offset > selection.end) || this.finished) { response.end(); break; }
                    if (!facts.waitLogged) { facts.waitLogged = true; this.log('reader-wait', { requestId, offset, capturedBytes: this.store.bytes }); }
                    await this.changed();
                }
            } catch (error) {
                if (!this.closed && !response.destroyed)
                    this.log('reader-error', { requestId, offset, code: error.code || 'WAV_CACHE_READ_FAILED', capturedBytes: this.store.bytes });
                response.destroy();
            }
        }
        handleRequest(request, response) {
            const requestId = ++this.requestSequence;
            const range = typeof request.headers.range === 'string' ? request.headers.range.slice(0, 128) : undefined;
            const address = wavHttpAddress(request, { token: this.token, port: this.server.address().port });
            this.log('request', { requestId, method: request.method, httpVersion: request.httpVersion, range,
                ...address.facts, addressAccepted: address.accepted, rejectionReason: address.reason,
                capturedBytes: this.store.bytes, complete: this.finished });
            let selection;
            if (!address.accepted) selection = { status: 404, reason: address.reason };
            else if (!['HEAD', 'GET'].includes(request.method)) selection = { status: 405, reason: 'unsupported-method' };
            else if (request.method === 'GET' && this.readers.size >= 8) selection = { status: 503, reason: 'reader-limit' };
            else selection = wavHttpRange(range, { available: this.store.bytes + HEADER_BYTES, complete: this.finished, limit: this.limit + HEADER_BYTES });
            const header = wavHeader(this.rate, this.channels, this.finished ? this.store.bytes : undefined);
            const fields = { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', Connection: 'close' };
            // HQPlayer's file reader also sees an identity body before EOF: no HTTP chunk delimiters in a live WAV.
            response.useChunkedEncodingByDefault = false;
            if (selection.contentRange) fields['Content-Range'] = selection.contentRange;
            if (selection.status === 503) fields['Retry-After'] = '1';
            if (selection.status === 416) fields['Content-Range'] = `bytes */${this.finished ? this.store.bytes + HEADER_BYTES : this.limit + HEADER_BYTES}`;
            if (selection.status < 300 && selection.end !== null) fields['Content-Length'] = selection.end - selection.start + 1;
            if (selection.status >= 300) fields['Content-Length'] = 0;
            const facts = { sentBytes: 0 };
            this.log('response', { requestId, status: selection.status, start: selection.start, end: selection.end,
                contentRange: selection.contentRange, contentLength: fields['Content-Length'] ?? null, reason: selection.reason,
                declaredDataBytes: this.finished ? this.store.bytes : null, lengthKind: this.finished ? 'exact' : 'unknown-live' });
            response.on('close', () => {
                this.readers.delete(response); this.wake();
                this.log('reader-close', { requestId, sentBytes: facts.sentBytes, capturedBytes: this.store.bytes,
                    reason: this.closed ? 'owner-stop' : response.writableFinished ? 'completed' : 'peer-disconnected', sourceRetained: !this.closed });
            });
            response.on('error', error => this.log('socket-error', { requestId, code: error.code || 'HTTP_WRITE_FAILED' }));
            response.on('drain', () => this.wake());
            response.writeHead(selection.status, fields);
            if (request.method === 'HEAD' || selection.status >= 300) return response.end();
            this.readers.add(response); response.flushHeaders();
            void this.readResponse(response, selection, header, requestId, facts);
        }
        async start() {
            this.check(this.session);
            if (this.server) return this.url;
            await this.store.open();
            this.log('cache-open', { sampleRate: this.rate, channels: this.channels, sampleFormat: this.format,
                dataOffset: HEADER_BYTES, maximumDataBytes: this.limit, formatTag: 'WAVE_FORMAT_EXTENSIBLE', pcmUnchanged: true });
            this.server = http.createServer({ highWaterMark: this.maximumChunkBytes }, (request, response) => this.handleRequest(request, response));
            this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
            await new Promise((resolve, reject) => {
                this.server.once('error', reject);
                this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
            });
            this.url = `http://127.0.0.1:${this.server.address().port}/${this.token}.wav`;
            return this.url;
        }
        async close() {
            if (this.closingWav) return this.closingWav;
            this.closed = true; this.wake();
            this.closingWav = (async () => {
                for (const socket of this.sockets) socket.destroy();
                if (this.server) await new Promise((resolve, reject) => this.server.close(error =>
                    !error || error.code === 'ERR_SERVER_NOT_RUNNING' ? resolve() : reject(error)));
                await this.store.close();
                this.log('cache-close', { capturedBytes: this.store.bytes, uniqueReadBytes: this.highWaterRead, removed: true });
            })().catch(error => { this.closingWav = null; throw error; });
            return this.closingWav;
        }
    };
}
module.exports = { wavHeader, liveDataLimit, createWavPcmSource };
