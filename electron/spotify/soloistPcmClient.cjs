const { createSoloistSshInvoker } = require('./soloistSshInvoke.cjs');

// Main-process-only candidate: private guest URL/bearer never appear in returned values or errors.
// Soloist's fixed prepared PCM does not prove original codec, original bit depth or lossless quality.
const RATE = 44100, CHANNELS = 2, FRAME_BYTES = 8, MAX_DURATION_MS = 3600000;
const STATES = new Set(['prepared', 'running', 'draining', 'ended', 'paused', 'closed', 'superseded', 'overflow', 'reader_disconnected', 'idle_timeout', 'format_changed', 'authorization_lost', 'provider_restarted']);
const REASONS = new Set(['eof', 'track_changed', ...STATES]);
const CODES = new Set(['INVALID_REQUEST', 'CANCELLED', 'APPLIANCE_UNAVAILABLE', 'CONTROL_TIMEOUT', 'CONTROL_FAILED', 'CONTROL_RESPONSE_TOO_LARGE',
    'CONTROL_REJECTED', 'CONTROL_PROTOCOL_INVALID', 'CONTROL_BUSY', 'AUTH_REQUIRED', 'DEVICE_INACTIVE', 'TRACK_NOT_CURRENT', 'PLAYBACK_STATE_UNCONFIRMED', 'SEEK_UNCONFIRMED',
    'STALE_SESSION', 'READER_ALREADY_USED', 'NOT_PREPARED', 'PCM_SOURCE_UNAVAILABLE', 'PCM_FORMAT_INVALID', 'PCM_BLOCK_INVALID', 'PCM_DURATION_EXCEEDED', 'PCM_TRUNCATED', 'PCM_INTERRUPTED']);
const fail = code => { throw Object.assign(new Error(`Spotify Soloist: ${code}`), { code }); };
const safeError = error => Object.assign(new Error(`Spotify Soloist: ${CODES.has(error?.code) ? error.code : 'CONTROL_FAILED'}`), { code: CODES.has(error?.code) ? error.code : 'CONTROL_FAILED' });
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function requestValues(value) {
    if (!value || !/^[A-Za-z0-9-]{1,100}$/.test(value.session || '') || !/^[A-Za-z0-9]{22}$/.test(value.trackId || '')
        || !integer(value.positionMs ?? 0, 0, MAX_DURATION_MS) || (value.durationMs != null && !integer(value.durationMs, 1, MAX_DURATION_MS))
        || (value.selectionPending != null && typeof value.selectionPending !== 'boolean')
        || (value.requestedQuality != null && !['standard', 'high', 'lossless'].includes(value.requestedQuality))) fail('INVALID_REQUEST');
    if (value.durationMs != null && (value.positionMs || 0) >= value.durationMs) fail('INVALID_REQUEST');
    return { session: value.session, uri: `spotify:track:${value.trackId}`, position_ms: value.positionMs || 0, requestedPositionMs: value.positionMs || 0,
        ...(value.durationMs == null ? {} : { duration_ms: value.durationMs }), requestedQuality: value.requestedQuality || null,
        selectionPending: value.selectionPending === true };
}
function publicState(value, record) {
    if (!value || value.uri !== record.uri || !integer(value.generation, 1, Number.MAX_SAFE_INTEGER)
        || !STATES.has(value.state) || (value.reason != null && !REASONS.has(value.reason))
        || !integer(value.duration_ms, 1, MAX_DURATION_MS) || !integer(value.position_ms, 0, value.duration_ms - 1)
        || ![value.accepted_frames, value.delivered_frames].every(number => integer(number, 0, Math.floor((value.duration_ms - value.position_ms) * RATE / 1000)))
        || !integer(value.queued_bytes, 0, RATE * FRAME_BYTES * 2) || value.queued_bytes % FRAME_BYTES !== 0
        || value.delivered_frames > value.accepted_frames || value.queued_bytes > RATE * FRAME_BYTES * 2
        || value.prepared_pcm?.sample_rate !== RATE || value.prepared_pcm?.channels !== CHANNELS || value.prepared_pcm?.bits !== 32) fail('CONTROL_PROTOCOL_INVALID');
    return { session: record.session, generation: value.generation, trackId: record.uri.slice(14), state: value.state, reason: value.reason ?? null,
        positionMs: value.position_ms, requestedPositionMs: record.requestedPositionMs, durationMs: value.duration_ms, acceptedFrames: value.accepted_frames, deliveredFrames: value.delivered_frames,
        queuedBytes: value.queued_bytes, requestedQuality: record.requestedQuality, actualQuality: null,
        sourceFormat: { codec: null, bitDepth: null, sampleRate: null, bitrate: null, lossless: null, encodingVerified: false },
        preparedAudio: { codec: 'PCM', sampleRate: RATE, channels: CHANNELS, bitDepth: 32, sampleFormat: 's32le' } };
}
function privateDescriptor(value, record, port) {
    const state = publicState(value, record); let url;
    try { url = new URL(value.url); } catch { fail('CONTROL_PROTOCOL_INVALID'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || url.username || url.password || url.search || url.hash
        || !/^\/pcm\/[A-Za-z0-9_-]{20,100}$/.test(url.pathname) || !value.headers || Object.keys(value.headers).length !== 1
        || !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(value.headers.Authorization || '') || state.positionMs !== record.position_ms) fail('CONTROL_PROTOCOL_INVALID');
    return { state, url: url.href, authorization: value.headers.Authorization };
}
function evidence(value, uri, expected, positionMs) {
    if (!Array.isArray(value?.evidence) || value.evidence.length > 256) fail('CONTROL_PROTOCOL_INVALID');
    const auth = value.evidence.filter(item => item?.type === 'auth_state').at(-1);
    if (!auth || typeof auth.logged_in !== 'boolean' || typeof auth.is_active !== 'boolean') fail('CONTROL_PROTOCOL_INVALID');
    if (!auth.logged_in) fail('AUTH_REQUIRED');
    if (!auth.is_active) fail('DEVICE_INACTIVE');
    const playback = value.evidence.filter(item => item?.type === 'playback_state').at(-1);
    if (!playback || playback.uri !== uri) fail('TRACK_NOT_CURRENT');
    if (expected && playback.status !== expected) fail('PLAYBACK_STATE_UNCONFIRMED');
    // Position is checked while officially paused: no observation-time extrapolation is used.
    if (positionMs != null && (!integer(playback.position_ms, 0, MAX_DURATION_MS) || Math.abs(playback.position_ms - positionMs) > 250)) fail('SEEK_UNCONFIRMED');
    return playback;
}
function validateWave(bytes) {
    if (bytes.length !== 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== 0xffffffff
        || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16
        || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== CHANNELS || bytes.readUInt32LE(24) !== RATE
        || bytes.readUInt32LE(28) !== RATE * FRAME_BYTES || bytes.readUInt16LE(32) !== FRAME_BYTES || bytes.readUInt16LE(34) !== 32
        || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== 0xffffffff) fail('PCM_FORMAT_INVALID');
}
function createSoloistPcmClient({ invoke, fetchImpl = globalThis.fetch, port = 28802, selectionTimeoutMs = 5000, selectionPollMs = 100, ...sshOptions } = {}) {
    if (!integer(port, 1, 65535) || !integer(selectionTimeoutMs, 50, 10000) || !integer(selectionPollMs, 10, 500)
        || typeof fetchImpl !== 'function') fail('INVALID_REQUEST');
    const transport = invoke || createSoloistSshInvoker(sshOptions);
    invoke = (...args) => Promise.resolve().then(() => transport(...args)).catch(error => { throw safeError(error); });
    let current = null, revision = 0, disposed = false, queue = Promise.resolve(), queued = 0;
    function serial(work) {
        if (queued >= 16) return Promise.reject(Object.assign(new Error('Spotify Soloist: CONTROL_BUSY'), { code: 'CONTROL_BUSY' }));
        queued++;
        const task = queue.catch(() => {}).then(work).finally(() => { queued--; }); queue = task; return task;
    }
    function owned(record) { if (disposed || current !== record || record.revision !== revision || record.controller.signal.aborted) fail('CANCELLED'); }
    function get(session) { if (disposed) fail('CANCELLED'); if (!current || current.session !== session) fail('STALE_SESSION'); return current; }
    function interrupt(record, reason) {
        if (!record) return;
        record.reason = reason; record.controller.abort(); void record.reader?.cancel().catch(() => {});
        record.resolveCompletion({ kind: reason, session: record.session, generation: record.descriptor?.state.generation ?? null });
    }
    async function closeRemote(record) {
        if (!record?.descriptor) return;
        try { await invoke('pcm', 'close', { generation: record.descriptor.state.generation }); }
        catch (error) { if (!['CONTROL_REJECTED', 'CANCELLED'].includes(error?.code)) throw error; }
    }
    async function observeSelection(record) {
        if (!record.selectionPending) {
            const control = await invoke('soloist', 'status', { observe_seconds: 1 }, { signal: record.controller.signal }); owned(record);
            evidence(control, record.uri); record.selectionConfirmed = true; return;
        }
        const window = new AbortController();
        const timer = setTimeout(() => window.abort(), selectionTimeoutMs);
        const signal = AbortSignal.any([window.signal, record.controller.signal]);
        try {
            while (true) {
                owned(record); signal.throwIfAborted();
                const control = await new Promise((resolve, reject) => {
                    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
                    signal.addEventListener('abort', abort, { once: true });
                    Promise.resolve().then(() => { signal.throwIfAborted(); return invoke('soloist', 'status', { observe_seconds: 1 }, { signal }); })
                        .then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
                    if (signal.aborted) abort();
                }); owned(record);
                try { evidence(control, record.uri); record.selectionConfirmed = true; return; }
                catch (error) {
                    // The acknowledged selection can report its new URI before
                    // becoming active after a provider reload. Wait read-only for
                    // activation; logged-out or malformed evidence is never accepted.
                    const playback = control?.evidence?.filter(item => item?.type === 'playback_state').at(-1);
                    if (!['TRACK_NOT_CURRENT', 'DEVICE_INACTIVE'].includes(error?.code) || !Array.isArray(control?.evidence)
                        || !playback || (playback.uri !== null && !/^spotify:track:[A-Za-z0-9]{22}$/.test(playback.uri || ''))) throw error;
                }
                await new Promise((resolve, reject) => {
                    const abort = () => { clearTimeout(wait); signal.removeEventListener('abort', abort); reject(signal.reason); };
                    const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, selectionPollMs);
                    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
                });
            }
        } catch (error) {
            if (record.controller.signal.aborted || current !== record || disposed) fail('CANCELLED');
            if (window.signal.aborted) fail('PLAYBACK_STATE_UNCONFIRMED');
            throw error;
        } finally { clearTimeout(timer); }
    }
    async function prepare(value) {
        const input = requestValues(value); if (disposed) fail('CANCELLED');
        const previous = current, ownRevision = ++revision; interrupt(previous, 'superseded');
        let resolveCompletion;
        const completed = new Promise(resolve => { resolveCompletion = resolve; });
        const record = { ...input, revision: ownRevision, controller: new AbortController(), descriptor: null, reader: null, readerUsed: false,
            state: null, reason: null, completed, resolveCompletion }; current = record;
        return serial(async () => {
            owned(record); await closeRemote(previous); owned(record);
            await observeSelection(record); owned(record);
            // This candidate cannot select arbitrary songs. For the authenticated current URI,
            // pause and verify an official seek before assigning an origin to captured PCM.
            await invoke('soloist', 'pause', { observe_seconds: 1, expected_uri: record.uri }, { signal: record.controller.signal }); owned(record);
            const paused = await invoke('soloist', 'status', { observe_seconds: 1 }, { signal: record.controller.signal }); owned(record);
            evidence(paused, record.uri, 'paused');
            await invoke('soloist', 'seek', { position_ms: record.position_ms, observe_seconds: 1, expected_uri: record.uri }, { signal: record.controller.signal }); owned(record);
            // Seeking can restart the producer even while the official playback state stays paused.
            // Guest pause waits for that source to release before a new PCM generation is prepared.
            await invoke('soloist', 'pause', { observe_seconds: 1, expected_uri: record.uri }, { signal: record.controller.signal }); owned(record);
            const positioned = await invoke('soloist', 'status', { observe_seconds: 1 }, { signal: record.controller.signal }); owned(record);
            const confirmed = evidence(positioned, record.uri, 'paused', record.position_ms);
            record.position_ms = confirmed.position_ms;
            const raw = await invoke('pcm', 'prepare', { uri: record.uri, position_ms: record.position_ms, ...(record.duration_ms ? { duration_ms: record.duration_ms } : {}) }, { signal: record.controller.signal });
            owned(record); const descriptor = privateDescriptor(raw, record, port);
            if (previous?.descriptor && descriptor.state.generation <= previous.descriptor.state.generation) fail('CONTROL_PROTOCOL_INVALID');
            record.descriptor = descriptor; record.state = descriptor.state;
            return { ...record.state, completed: record.completed };
        }).catch(async error => {
            const original = safeError(error);
            if (current === record) interrupt(record, error?.code === 'CANCELLED' ? 'cancelled' : 'failed');
            // An acknowledged official selection may already be playing even if
            // PCM preparation fails. Cleanup must independently prove that this
            // receiver still owns the same active URI before pausing it.
            await serial(async () => {
                if (disposed || current !== record) return;
                if (record.selectionPending && !record.selectionConfirmed) return;
                try {
                    const before = await invoke('soloist', 'status', { observe_seconds: 1 });
                    if (disposed || current !== record) return;
                    evidence(before, record.uri);
                    await invoke('soloist', 'pause', { observe_seconds: 1, expected_uri: record.uri });
                    if (disposed || current !== record) return;
                    const paused = await invoke('soloist', 'status', { observe_seconds: 1 });
                    if (disposed || current !== record) return;
                    evidence(paused, record.uri, 'paused');
                } finally { if (!disposed && current === record) await closeRemote(record); }
            }).catch(() => {});
            throw original;
        });
    }
    async function status(session) {
        const record = get(session); owned(record);
        const value = await invoke('pcm', 'status', {}, { signal: record.controller.signal }); owned(record);
        if (typeof value.auth_state?.logged_in !== 'boolean' || typeof value.auth_state?.is_active !== 'boolean') fail('CONTROL_PROTOCOL_INVALID');
        if (!value.auth_state.logged_in) { interrupt(record, 'authorization_lost'); fail('AUTH_REQUIRED'); }
        if (!value.session || value.session.generation !== record.descriptor?.state.generation) { interrupt(record, 'superseded'); fail('CANCELLED'); }
        record.state = publicState(value.session, record); return { ...record.state };
    }
    function openReadable(session, { signal } = {}) {
        const record = get(session); owned(record);
        if (!record.descriptor || record.readerUsed) fail(record.readerUsed ? 'READER_ALREADY_USED' : 'NOT_PREPARED');
        record.readerUsed = true;
        return (async function* () {
            const abort = () => interrupt(record, 'cancelled'); signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            let header = Buffer.alloc(0), carry = Buffer.alloc(0), pcmBytes = 0;
            try {
                owned(record);
                const response = await fetchImpl(record.descriptor.url, { headers: { Authorization: record.descriptor.authorization },
                    redirect: 'error', signal: record.controller.signal }); owned(record);
                if (!response.ok || !response.body) fail([401, 403].includes(response.status) ? 'AUTH_REQUIRED' : 'PCM_SOURCE_UNAVAILABLE');
                if (response.headers.get('x-folia-generation') !== String(record.descriptor.state.generation)
                    || response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/wav') fail('PCM_FORMAT_INVALID');
                record.reader = response.body.getReader();
                const maximum = Math.floor((record.state.durationMs - record.state.positionMs) * RATE / 1000) * FRAME_BYTES;
                while (true) {
                    owned(record); const { done, value } = await record.reader.read(); owned(record);
                    if (done) break;
                    if (!(value instanceof Uint8Array) || value.byteLength > 262144) fail('PCM_BLOCK_INVALID');
                    let bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                    if (header.length < 44) {
                        const length = Math.min(44 - header.length, bytes.length); header = Buffer.concat([header, bytes.subarray(0, length)]); bytes = bytes.subarray(length);
                        if (header.length === 44) validateWave(header);
                    }
                    if (!bytes.length) continue;
                    const available = Buffer.concat([carry, bytes]); const aligned = available.length - available.length % FRAME_BYTES;
                    carry = Buffer.from(available.subarray(aligned)); pcmBytes += aligned;
                    if (pcmBytes > maximum) fail('PCM_DURATION_EXCEEDED');
                    for (let offset = 0; offset < aligned; offset += 65536) { owned(record); yield Buffer.from(available.subarray(offset, Math.min(aligned, offset + 65536))); }
                }
                if (header.length !== 44 || carry.length) fail('PCM_TRUNCATED');
                const final = await status(session); owned(record);
                if (final.reason !== 'eof' || final.deliveredFrames * FRAME_BYTES !== pcmBytes || final.acceptedFrames !== final.deliveredFrames || pcmBytes !== maximum) fail('PCM_INTERRUPTED');
                record.reason = 'eof';
                record.resolveCompletion({ kind: 'eof', session, generation: final.generation, frames: pcmBytes / FRAME_BYTES });
            } catch (error) {
                if (record.controller.signal.aborted || current !== record || signal?.aborted) fail('CANCELLED');
                interrupt(record, 'failed');
                if (CODES.has(error?.code)) throw safeError(error);
                fail('PCM_SOURCE_UNAVAILABLE');
            } finally {
                signal?.removeEventListener('abort', abort); await record.reader?.cancel().catch(() => {}); record.reader?.releaseLock(); record.reader = null;
                if (record.reason === null) { record.reason = 'reader_disconnected'; record.resolveCompletion({ kind: 'reader_disconnected', session, generation: record.descriptor?.state.generation }); }
            }
        })();
    }
    async function play(session) {
        const record = get(session); return serial(async () => {
            owned(record);
            const before = await invoke('soloist', 'status', { observe_seconds: 1 }, { signal: record.controller.signal }); owned(record);
            evidence(before, record.uri);
            await invoke('soloist', 'play', { observe_seconds: 1, expected_uri: record.uri }, { signal: record.controller.signal }); owned(record);
            const value = await invoke('soloist', 'status', { observe_seconds: 1 }, { signal: record.controller.signal }); owned(record);
            evidence(value, record.uri, 'playing'); record.state = { ...record.state, state: 'running' }; return { ...record.state };
        });
    }
    async function pause(session) {
        const record = get(session); interrupt(record, 'paused');
        return serial(async () => {
            if (disposed || current !== record) fail('CANCELLED');
            await closeRemote(record);
            if (record.selectionPending && !record.selectionConfirmed) return { session: record.session, state: 'paused', reason: 'paused' };
            const before = await invoke('soloist', 'status', { observe_seconds: 1 });
            if (disposed || current !== record) fail('CANCELLED');
            evidence(before, record.uri);
            await invoke('soloist', 'pause', { observe_seconds: 1, expected_uri: record.uri });
            const value = await invoke('soloist', 'status', { observe_seconds: 1 });
            if (disposed || current !== record) fail('CANCELLED');
            evidence(value, record.uri, 'paused'); record.state = { ...record.state, state: 'paused', reason: 'paused' }; return { ...record.state };
        });
    }
    async function seek(session, positionMs) {
        const record = get(session);
        if (!integer(positionMs, 0, (record.state?.durationMs || MAX_DURATION_MS) - 1)) fail('INVALID_REQUEST');
        interrupt(record, 'seek');
        return prepare({ session, trackId: record.uri.slice(14), positionMs, requestedQuality: record.requestedQuality, durationMs: record.state.durationMs });
    }
    async function close(session) {
        const record = get(session); interrupt(record, 'closed');
        return serial(async () => { await closeRemote(record); if (current === record) current = null; return { session, state: 'closed' }; });
    }
    return { prepare, status, openReadable, play, pause, seek, close, dispose() { disposed = true; ++revision; const previous = current; current = null; interrupt(previous, 'closed'); void serial(() => closeRemote(previous)).catch(() => {}); } };
}
module.exports = { createSoloistPcmClient };
