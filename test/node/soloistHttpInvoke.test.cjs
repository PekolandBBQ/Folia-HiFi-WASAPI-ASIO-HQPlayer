const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSoloistHttpInvoker } = require('../../electron/spotify/soloistHttpInvoke.cjs');
const TRACK = `spotify:track:${'a'.repeat(22)}`;
const credential = () => ({ endpoint: 'http://127.0.0.1:28802', bearer: 'fake_private_runtime_value_'.repeat(2), lifecycle: 'a'.repeat(32) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const code = (expected, promise) => assert.rejects(promise, error => error.code === expected && error.message === `Spotify Soloist: ${expected}`);

test('cold readiness retries only initial refused connections and gets a fresh private ready response', async () => {
    let calls = 0, bootstraps = 0; const stages = [];
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { bootstraps++; return credential(); }, fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:28802/ready'); assert.equal(options.method, 'GET');
        if (++calls === 1) throw Object.assign(new Error('Private connect refused'), { cause: { code: 'ECONNREFUSED' } });
        return json({ ready: true, stage: 'ready', command: 'status', evidence: [{ type: 'auth_state', logged_in: true, is_active: true }, { type: 'playback_state', uri: TRACK, status: 'paused' }] });
    } });
    const ready = await invoke.waitReady({ onStage: value => stages.push(value) });
    assert.equal(ready.ready, true); assert.equal(calls, 2); assert.equal(bootstraps, 1);
    assert.deepEqual(stages, ['waiting-for-appliance', 'ready']); invoke.dispose();
});

test('stale runtime readiness rejection is not retried and never sends a mutation', async () => {
    let calls = 0;
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => { calls++; return json({ code: 'AUTH_REQUIRED' }, 403); } });
    await code('APPLIANCE_UNAVAILABLE', invoke.waitReady()); assert.equal(calls, 1); invoke.dispose();
});

test('readiness remains bounded and cancellable while listener is unavailable', async () => {
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => { throw Object.assign(new Error('Private connect refused'), { code: 'ECONNREFUSED' }); } });
    await code('CONTROL_TIMEOUT', invoke.waitReady({ timeoutMs: 100 }));
    const controller = new AbortController(); const pending = invoke.waitReady({ signal: controller.signal }); setTimeout(() => controller.abort(), 10);
    await code('CANCELLED', pending); invoke.dispose();
});

test('one private bootstrap supports compatible injected soloist and pcm operations', async () => {
    let bootstraps = 0; const requests = [];
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { bootstraps++; return credential(); }, fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method, body: options.body, lifecycle: options.headers['X-Folia-Lifecycle'], redirect: options.redirect });
        return json({ evidence: [], command: 'status' });
    } });
    await invoke('soloist', 'status', { observe_seconds: 1 }); await invoke('pcm', 'status', {});
    await invoke('pcm', 'close', { generation: 1 });
    assert.equal(bootstraps, 1);
    assert.deepEqual(requests.map(value => [value.url, value.method]), [
        ['http://127.0.0.1:28802/control/status', 'POST'], ['http://127.0.0.1:28802/status', 'GET'], ['http://127.0.0.1:28802/close', 'POST']]);
    assert.ok(requests.every(value => value.lifecycle === 'a'.repeat(32) && value.redirect === 'error'));
    invoke.dispose();
});
test('invalid current-track request fails before bootstrap or HTTP', async () => {
    let calls = 0;
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { calls++; return credential(); }, fetchImpl: async () => { calls++; return json({}); } });
    await code('INVALID_REQUEST', invoke('soloist', 'play', { expected_uri: TRACK, uri: `spotify:track:${'b'.repeat(22)}` }));
    await code('INVALID_REQUEST', invoke('soloist', 'seek', { expected_uri: TRACK, position_ms: true }));
    await code('INVALID_REQUEST', invoke('soloist', 'pause', { expected_uri: TRACK, key: 'untrusted' }));
    assert.equal(calls, 0); invoke.dispose();
});
test('bootstrap cannot redirect credentials to a LAN or nonfixed endpoint', async () => {
    let calls = 0;
    for (const endpoint of ['http://192.168.31.1:28802', 'http://127.0.0.1:9999', 'http://127.0.0.1:28802?token=fake']) {
        const invoke = createSoloistHttpInvoker({ bootstrap: async () => ({ ...credential(), endpoint }), fetchImpl: async () => { calls++; return json({}); } });
        await code('CONTROL_PROTOCOL_INVALID', invoke('soloist', 'status')); invoke.dispose();
    }
    assert.equal(calls, 0);
});

test('main-owned dynamic PCM port must match the private bootstrap endpoint exactly', async () => {
    let calls = 0;
    const invoke = createSoloistHttpInvoker({ pcmPort: 33992,
        bootstrap: async () => ({ ...credential(), endpoint: 'http://127.0.0.1:33992' }), fetchImpl: async (url, options) => {
            calls++; assert.equal(url, 'http://127.0.0.1:33992/control/status');
            assert.equal(options.headers['X-Folia-Lifecycle'], credential().lifecycle); return json({ command: 'status' });
        } });
    assert.equal((await invoke('soloist', 'status')).command, 'status'); assert.equal(calls, 1); invoke.dispose();
    const wrong = createSoloistHttpInvoker({ pcmPort: 33992, bootstrap: async () => credential(), fetchImpl: async () => { calls++; } });
    await code('CONTROL_PROTOCOL_INVALID', wrong('soloist', 'status')); assert.equal(calls, 1); wrong.dispose();
    for (const pcmPort of [0, 65536, '33992', 33992.5])
        assert.throws(() => createSoloistHttpInvoker({ pcmPort, bootstrap: async () => credential() }), error => error.code === 'INVALID_REQUEST');
});
test('restart credential rejection does not retry a mutation and forces a new private bootstrap', async () => {
    let calls = 0, bootstraps = 0;
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { bootstraps++; return credential(); }, fetchImpl: async () => ++calls === 1 ? json({ code: 'AUTH_REQUIRED' }, 403) : json({ command: 'status', evidence: [] }) });
    await code('APPLIANCE_UNAVAILABLE', invoke('soloist', 'pause', { expected_uri: TRACK }));
    assert.equal(calls, 1); await invoke('soloist', 'status'); assert.equal(bootstraps, 2); invoke.dispose();
});
test('server arbitrary errors and fetch errors never expose private values', async () => {
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => json({ code: 'unknown', message: credential().bearer }, 500) });
    await code('CONTROL_REJECTED', invoke('soloist', 'status')); invoke.dispose();
    const failing = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => { throw new Error(credential().bearer); } });
    await code('CONTROL_FAILED', failing('soloist', 'status')); failing.dispose();
});
test('streamed response is bounded and malformed JSON is rejected', async () => {
    const large = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => new Response('a'.repeat(70000), { headers: { 'content-type': 'application/json' } }) });
    await code('CONTROL_RESPONSE_TOO_LARGE', large('soloist', 'status')); large.dispose();
    const broken = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => new Response('{', { headers: { 'content-type': 'application/json' } }) });
    await code('CONTROL_PROTOCOL_INVALID', broken('soloist', 'status')); broken.dispose();
});
test('pre-cancelled request performs zero bootstrap and fetch calls', async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { calls++; return credential(); }, fetchImpl: async () => { calls++; return json({}); } });
    await code('CANCELLED', invoke('soloist', 'status', {}, { signal: controller.signal })); assert.equal(calls, 0); invoke.dispose();
});
test('timeout remains bounded even if a bootstrap or injected fetch ignores cancellation', async () => {
    for (const stalled of ['bootstrap', 'fetch']) {
        const invoke = createSoloistHttpInvoker({ timeoutMs: 100,
            bootstrap: stalled === 'bootstrap' ? () => new Promise(() => {}) : async () => credential(),
            fetchImpl: () => new Promise(() => {}) });
        await code('CONTROL_TIMEOUT', invoke('soloist', 'status')); invoke.dispose();
    }
});
test('inflight abort and dispose cancel private HTTP without returning its raw error', async () => {
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(credential().bearer)), { once: true });
    }) });
    const pending = invoke('soloist', 'status'); await new Promise(resolve => setTimeout(resolve, 10)); invoke.dispose();
    await code('CANCELLED', pending); await code('CANCELLED', invoke('soloist', 'status'));
});
test('actual isolated local HTTP request preserves fixed target validation and bearer-only memory contract', async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests++; assert.equal(request.url, '/control/status'); assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, `Bearer ${credential().bearer}`);
        assert.equal(request.headers['x-folia-lifecycle'], credential().lifecycle);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ command: 'status', evidence: [{ type: 'auth_state', logged_in: true, is_active: true }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const localPort = server.address().port;
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: (url, options) => {
        assert.equal(url, 'http://127.0.0.1:28802/control/status');
        return fetch(`http://127.0.0.1:${localPort}/control/status`, options); // test injection only; never contacts live 28802
    } });
    try { const value = await invoke('soloist', 'status'); assert.equal(value.evidence[0].logged_in, true); assert.equal(requests, 1); }
    finally { invoke.dispose(); await new Promise(resolve => server.close(resolve)); }
});

test('read-only status recovers from actual loopback refusal once using the same private lifecycle', async () => {
    let requests = 0, bootstraps = 0;
    const attempts = [];
    const server = http.createServer((request, response) => {
        requests++; assert.equal(request.url, '/control/status');
        assert.equal(request.headers.authorization, `Bearer ${credential().bearer}`);
        assert.equal(request.headers['x-folia-lifecycle'], credential().lifecycle);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ command: 'status', evidence: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const localPort = server.address().port; await new Promise(resolve => server.close(resolve));
    const invoke = createSoloistHttpInvoker({ bootstrap: async () => { bootstraps++; return credential(); }, fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:28802/control/status'); attempts.push(options);
        try { return await fetch(`http://127.0.0.1:${localPort}/control/status`, options); }
        catch (error) {
            assert.equal(error.cause?.code, 'ECONNREFUSED');
            assert.equal(attempts.length, 1);
            await new Promise(resolve => server.listen(localPort, '127.0.0.1', resolve));
            throw error; // Preserve the real initial failure for transport observations.
        }
    } });
    try {
        assert.equal((await invoke('soloist', 'status', { observe_seconds: 1 })).command, 'status');
        assert.equal(attempts.length, 2); assert.equal(requests, 1); assert.equal(bootstraps, 1);
        assert.deepEqual(attempts[0].headers, attempts[1].headers);
        assert.equal(attempts[0].body, attempts[1].body); assert.equal(attempts[0].signal, attempts[1].signal);
    } finally { invoke.dispose(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});

test('runtime refusal retries at most once and never retries a mutation or another transport failure', async () => {
    const refused = () => Object.assign(new Error('Private listener refused'), { cause: { code: 'ECONNREFUSED' } });
    for (const [surface, operation, payload, transportCode, expectedCalls] of [
        ['soloist', 'status', {}, 'ECONNREFUSED', 2], ['pcm', 'status', {}, 'ECONNREFUSED', 1],
        ['soloist', 'play', { expected_uri: TRACK }, 'ECONNREFUSED', 1],
        ['soloist', 'pause', { expected_uri: TRACK }, 'ECONNREFUSED', 1],
        ['soloist', 'seek', { expected_uri: TRACK, position_ms: 1000 }, 'ECONNREFUSED', 1],
        ['soloist', 'status', {}, 'ECONNRESET', 1], ['soloist', 'status', {}, 'EPIPE', 1],
    ]) {
        let calls = 0;
        const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => {
            calls++; const error = refused(); error.cause.code = transportCode; throw error;
        } });
        await code('CONTROL_FAILED', invoke(surface, operation, payload)); assert.equal(calls, expectedCalls); invoke.dispose();
    }
});

test('runtime read-only status never retries an authenticated HTTP rejection', async () => {
    for (const status of [429, 500]) {
        let calls = 0;
        const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => {
            calls++; return json({ code: 'CONTROL_FAILED' }, status);
        } });
        await code('CONTROL_FAILED', invoke('soloist', 'status')); assert.equal(calls, 1); invoke.dispose();
    }
});

test('one status retry retains the original total deadline rather than extending a slow first failure', async () => {
    let calls = 0;
    const invoke = createSoloistHttpInvoker({ timeoutMs: 100, bootstrap: async () => credential(), fetchImpl: async () => {
        calls++; await new Promise(resolve => setTimeout(resolve, 75));
        throw Object.assign(new Error('Private listener refused'), { cause: { code: 'ECONNREFUSED' } });
    } });
    const startedAt = Date.now(); await code('CONTROL_TIMEOUT', invoke('soloist', 'status'));
    assert.equal(calls, 1); assert.ok(Date.now() - startedAt < 250); invoke.dispose();
});

test('cancel and dispose during the refusal delay prevent a second status request', async () => {
    for (const mode of ['cancel', 'dispose']) {
        let calls = 0; const controller = new AbortController();
        const invoke = createSoloistHttpInvoker({ bootstrap: async () => credential(), fetchImpl: async () => {
            calls++; setTimeout(() => mode === 'cancel' ? controller.abort() : invoke.dispose(), 10);
            throw Object.assign(new Error('Private listener refused'), { cause: { code: 'ECONNREFUSED' } });
        } });
        await code('CANCELLED', invoke('soloist', 'status', {}, { signal: controller.signal }));
        assert.equal(calls, 1); invoke.dispose();
    }
});
