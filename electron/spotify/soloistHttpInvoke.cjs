const failure = code => Object.assign(new Error(`Spotify Soloist: ${code}`), { code });
const CODES = new Set(['INVALID_REQUEST', 'CANCELLED', 'APPLIANCE_UNAVAILABLE', 'CONTROL_TIMEOUT', 'CONTROL_FAILED', 'CONTROL_RESPONSE_TOO_LARGE',
    'CONTROL_REJECTED', 'CONTROL_PROTOCOL_INVALID', 'CONTROL_BUSY', 'AUTH_REQUIRED', 'DEVICE_INACTIVE', 'TRACK_NOT_CURRENT', 'PLAYBACK_STATE_UNCONFIRMED',
    'SEEK_UNCONFIRMED', 'NOT_PREPARED', 'PCM_INTERRUPTED']);
const safe = error => {
    const value = failure(CODES.has(error?.code) ? error.code : 'CONTROL_FAILED');
    if (error?.readinessRetryable === true) Object.defineProperty(value, 'readinessRetryable', { value: true });
    return value;
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const uri = value => /^spotify:track:[A-Za-z0-9]{22}$/.test(value || '');
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function validate(surface, operation, payload) {
    if (!plain(payload)) throw failure('INVALID_REQUEST');
    let allowed;
    if (surface === 'soloist') {
        if (!['status', 'play', 'pause', 'seek'].includes(operation)) throw failure('INVALID_REQUEST');
        allowed = operation === 'status' ? ['observe_seconds'] : ['observe_seconds', 'expected_uri'];
        if (operation === 'play') allowed.push('uri');
        if (operation === 'seek') allowed.push('position_ms');
        if (operation !== 'status' && !uri(payload.expected_uri)) throw failure('INVALID_REQUEST');
        if (payload.uri != null && payload.uri !== payload.expected_uri) throw failure('INVALID_REQUEST');
        if (operation === 'seek' && !integer(payload.position_ms, 0, 3599999)) throw failure('INVALID_REQUEST');
        if (payload.observe_seconds != null && !integer(payload.observe_seconds, 1, 30)) throw failure('INVALID_REQUEST');
    } else if (surface === 'pcm') {
        if (!['prepare', 'status', 'close'].includes(operation)) throw failure('INVALID_REQUEST');
        allowed = operation === 'prepare' ? ['uri', 'position_ms', 'duration_ms'] : operation === 'close' ? ['generation'] : [];
        if (operation === 'prepare' && (!uri(payload.uri) || !integer(payload.position_ms, 0, 3599999)
            || payload.duration_ms != null && !integer(payload.duration_ms, 1, 3600000))) throw failure('INVALID_REQUEST');
        if (operation === 'close' && !integer(payload.generation, 1, Number.MAX_SAFE_INTEGER)) throw failure('INVALID_REQUEST');
    } else throw failure('INVALID_REQUEST');
    if (Object.keys(payload).some(key => !allowed.includes(key))) throw failure('INVALID_REQUEST');
    let body; try { body = JSON.stringify(payload); } catch { throw failure('INVALID_REQUEST'); }
    if (!body || Buffer.byteLength(body) > 16384) throw failure('INVALID_REQUEST');
    return body;
}
function bootstrapValues(value, port) {
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'bearer,endpoint,lifecycle'
        || value.endpoint !== `http://127.0.0.1:${port}` || !/^[A-Za-z0-9_-]{32,128}$/.test(value.bearer || '')
        || !/^[a-f0-9]{32}$/.test(value.lifecycle || '')) throw failure('CONTROL_PROTOCOL_INVALID');
    return { endpoint: value.endpoint, bearer: value.bearer, lifecycle: value.lifecycle };
}

// Main-process-only unpublished candidate. bootstrap is a fixed SSH child whose
// stdout stays private; there is deliberately no unauthenticated HTTP bootstrap.
function createSoloistHttpInvoker({ bootstrap, fetchImpl = globalThis.fetch, timeoutMs = 10000, pcmPort = 28802 } = {}) {
    if (process.type === 'renderer' || typeof bootstrap !== 'function' || typeof fetchImpl !== 'function'
        || !integer(timeoutMs, 100, 60000) || !integer(pcmPort, 1, 65535)) throw failure('INVALID_REQUEST');
    let privateBootstrap = null, disposed = false;
    const active = new Set();
    const request = async function(surface, operation, payload = {}, { signal } = {}, readiness = false) {
        const body = readiness ? null : validate(surface, operation, payload);
        if (disposed || signal?.aborted) throw failure('CANCELLED');
        const controller = new AbortController(); active.add(controller);
        let timedOut = false, reader;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        const controlled = promise => new Promise((resolve, reject) => {
            const cancelled = () => { controller.signal.removeEventListener('abort', cancelled); reject(failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED')); };
            if (controller.signal.aborted) { cancelled(); return; }
            controller.signal.addEventListener('abort', cancelled, { once: true });
            Promise.resolve(promise).then(value => { controller.signal.removeEventListener('abort', cancelled); resolve(value); }, error => {
                controller.signal.removeEventListener('abort', cancelled); reject(error);
            });
        });
        try {
            if (!privateBootstrap) {
                const pending = Promise.resolve().then(() => bootstrap({ signal: controller.signal })).then(value => {
                    if (disposed) throw failure('CANCELLED'); return bootstrapValues(value, pcmPort);
                });
                privateBootstrap = pending;
                pending.catch(() => { if (privateBootstrap === pending) privateBootstrap = null; });
            }
            const credential = await controlled(privateBootstrap);
            if (disposed || controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
            const endpoint = readiness ? '/ready' : surface === 'soloist' ? `/control/${operation}` : operation === 'prepare' ? '/session' : operation === 'close' ? '/close' : '/status';
            const method = readiness || surface === 'pcm' && operation === 'status' ? 'GET' : 'POST';
            let response;
            for (let attempt = 0; ; attempt++) { try {
                response = await controlled(fetchImpl(credential.endpoint + endpoint, { method, redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${credential.bearer}`, 'X-Folia-Lifecycle': credential.lifecycle,
                        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body } : {}) }));
                break;
            } catch (error) {
                // A loopback listener can refuse the first connection after a cold
                // output handshake. Only this read-only observation gets one retry,
                // under the original deadline and the same private lifecycle.
                if (!readiness && surface === 'soloist' && operation === 'status' && attempt === 0
                    && (error?.cause?.code || error?.code) === 'ECONNREFUSED' && !controller.signal.aborted) {
                    let wait;
                    try { await controlled(new Promise(resolve => { wait = setTimeout(resolve, 50); })); }
                    finally { clearTimeout(wait); }
                    if (disposed || controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
                    continue;
                }
                // Retry only a read-only cold listener check. An authenticated
                // runtime rejection, response timeout or mutation is never retried.
                if (readiness && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.cause?.code || error?.code)) {
                    const unavailable = failure('APPLIANCE_UNAVAILABLE');
                    Object.defineProperty(unavailable, 'readinessRetryable', { value: true }); throw unavailable;
                }
                throw error;
            } }
            if (disposed || controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
            if ([401, 403].includes(response.status)) { privateBootstrap = null; throw failure('APPLIANCE_UNAVAILABLE'); }
            if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw failure('CONTROL_PROTOCOL_INVALID');
            reader = response.body.getReader();
            let length = 0; const blocks = [];
            while (true) {
                const { done, value } = await controlled(reader.read());
                if (disposed || controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
                if (done) break;
                if (!(value instanceof Uint8Array)) throw failure('CONTROL_PROTOCOL_INVALID');
                length += value.byteLength; if (length > 65536) throw failure('CONTROL_RESPONSE_TOO_LARGE');
                blocks.push(Buffer.from(value));
            }
            let value; try { value = JSON.parse(Buffer.concat(blocks, length).toString('utf8')); } catch { throw failure('CONTROL_PROTOCOL_INVALID'); }
            if (!plain(value)) throw failure('CONTROL_PROTOCOL_INVALID');
            if (!response.ok) throw failure(CODES.has(value.code) ? value.code : 'CONTROL_REJECTED');
            return value;
        } catch (error) {
            if (controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
            throw safe(error);
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller);
            await reader?.cancel().catch(() => {}); reader?.releaseLock();
        }
    };
    const invoke = (surface, operation, payload = {}, options = {}) => request(surface, operation, payload, options);
    invoke.waitReady = async ({ signal, timeoutMs: readyTimeoutMs = 15000, onStage } = {}) => {
        if (!integer(readyTimeoutMs, 100, 60000)) throw failure('INVALID_REQUEST');
        if (disposed || signal?.aborted) throw failure('CANCELLED');
        const controller = new AbortController(); active.add(controller);
        let timedOut = false;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, readyTimeoutMs);
        try {
            onStage?.('waiting-for-appliance');
            while (true) {
                try {
                    const result = await request('soloist', 'status', {}, { signal: controller.signal }, true);
                    if (result.ready !== true || result.stage !== 'ready' || result.command !== 'status' || !Array.isArray(result.evidence)) throw failure('CONTROL_PROTOCOL_INVALID');
                    onStage?.('ready'); return result;
                } catch (error) {
                    if (controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
                    if (!error.readinessRetryable) throw error;
                    await new Promise((resolve, reject) => {
                        const cancelled = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', cancelled); reject(failure('CANCELLED')); };
                        const wait = setTimeout(() => { controller.signal.removeEventListener('abort', cancelled); resolve(); }, 50);
                        controller.signal.addEventListener('abort', cancelled, { once: true });
                        if (controller.signal.aborted) cancelled();
                    });
                }
            }
        } catch (error) {
            if (controller.signal.aborted) throw failure(timedOut ? 'CONTROL_TIMEOUT' : 'CANCELLED');
            throw safe(error);
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller);
        }
    };
    invoke.dispose = () => { disposed = true; privateBootstrap = null; for (const controller of active) controller.abort(); };
    return invoke;
}
module.exports = { createSoloistHttpInvoker };
