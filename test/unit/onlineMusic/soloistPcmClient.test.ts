import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';
const { createSoloistPcmClient } = createRequire(import.meta.url)('../../../electron/spotify/soloistPcmClient.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp', uri = `spotify:track:${trackId}`, bearer = 'Bearer ' + 'private-sentinel-token'.padEnd(43, 'z');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function wave() {
    const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(0xffffffff, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(44100, 24);
    header.writeUInt32LE(352800, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(0xffffffff, 40); return header;
}
function state(generation = 1, overrides = {}) {
    return { generation, uri, state: 'prepared', reason: null, duration_ms: 1, position_ms: 0,
        accepted_frames: 0, delivered_frames: 0, queued_bytes: 0, prepared_pcm: { sample_rate: 44100, channels: 2, bits: 32 },
        source_codec: 'unknown', actual_quality: 'unknown', ...overrides };
}
function control(status = 'paused', position = 0) {
    return { evidence: [{ type: 'auth_state', logged_in: true, is_active: true }, { type: 'playback_state', uri, status, position_ms: position }] };
}
async function fixture(options: Record<string, any> = {}) {
    const pcm = Buffer.alloc(352); for (let index = 0; index < pcm.length; index++) pcm[index] = index % 251;
    let generation = 0, latest = state(), playback = 'paused', position = 0, requests = 0, sourceActive = false, response: http.ServerResponse | null = null;
    const server = http.createServer((req, res) => {
        requests++; response = res;
        expect(req.headers.authorization).toBe(bearer);
        if (options.httpError) { res.writeHead(options.httpError).end(); return; }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Folia-Generation': String(options.httpGeneration ?? generation) });
        const bytes = Buffer.concat([options.header || wave(), options.body || pcm]);
        if (options.hold) { res.write(bytes.subarray(0, 44)); return; }
        // Odd chunk splits prove exact header stripping and complete frame assembly.
        let start = 0; for (const cut of [1, 7, 37, 45, 59]) { res.write(bytes.subarray(start, cut)); start = cut; }
        res.end(bytes.subarray(59));
        latest = state(generation, { state: 'ended', reason: options.reason || 'eof', accepted_frames: 44, delivered_frames: 44 });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const invoke = vi.fn(async (surface: string, operation: string, payload: Record<string, any>) => {
        if (surface === 'soloist') {
            if (operation === 'play') playback = 'playing'; if (operation === 'pause') { playback = 'paused'; sourceActive = false; }
            if (operation === 'seek') { if (!options.ignoreSeek) position = payload.position_ms; if (options.seekStartsProducer) sourceActive = true; }
            return options.ackOnly ? { evidence: [{ type: 'auth_state', logged_in: true, is_active: true }, { type: 'command_result', acknowledged: true }] } : control(playback, position);
        }
        if (operation === 'prepare') { if (sourceActive) throw Object.assign(new Error('not released'), { code: 'PLAYBACK_STATE_UNCONFIRMED' });
            generation++; latest = state(generation, { position_ms: payload.position_ms, duration_ms: payload.duration_ms || 1 });
            return { ...latest, url: `http://127.0.0.1:${port}/pcm/${'private-session-id'.padEnd(32, 'z')}`, headers: { Authorization: bearer }, ...options.descriptor }; }
        if (operation === 'status') return { auth_state: { logged_in: true, is_active: true }, session: latest };
        if (operation === 'close') return { closed: true };
    });
    const client = createSoloistPcmClient({ invoke, port, fetchImpl: options.fetchImpl || fetch,
        selectionTimeoutMs: options.selectionTimeoutMs, selectionPollMs: options.selectionPollMs });
    cleanups.push(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return { client, invoke, pcm, port, request: () => requests, response: () => response,
        playback: () => playback,
        prepare: () => client.prepare({ session: 'test-session', trackId, requestedQuality: 'lossless' }) };
}
it('reads one authenticated HTTP source as exact raw PCM without leaking descriptor or asserting lossless', async () => {
    const f = await fixture(); const ready = await f.prepare();
    expect(JSON.stringify(ready)).not.toContain('private'); expect(JSON.stringify(ready)).not.toContain('http:');
    expect(ready.requestedQuality).toBe('lossless'); expect(ready.actualQuality).toBeNull();
    expect(ready.sourceFormat).toMatchObject({ codec: null, bitDepth: null, lossless: null, encodingVerified: false });
    expect(ready.preparedAudio).toMatchObject({ sampleFormat: 's32le', sampleRate: 44100, bitDepth: 32 });
    const stream = f.client.openReadable('test-session');
    expect(() => f.client.openReadable('test-session')).toThrow('READER_ALREADY_USED');
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(f.pcm); expect(f.request()).toBe(1);
    expect(await ready.completed).toMatchObject({ kind: 'eof', frames: 44, generation: 1 });
});
it.each(['https://evil.invalid/pcm/' + 'x'.repeat(32), 'http://localhost:28802/pcm/' + 'x'.repeat(32), 'http://127.0.0.1:28802/pcm/' + 'x'.repeat(32) + '?token=private'])('rejects unsafe descriptor URL %s before any HTTP read', async url => {
    const f = await fixture({ descriptor: { url } }); await expect(f.prepare()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_INVALID' }); expect(f.request()).toBe(0);
});
it('rejects malformed bearer headers, formats and frame counters', async () => {
    for (const descriptor of [{ headers: { Authorization: bearer, Extra: 'private' } }, { headers: { Authorization: 'Bearer private\r\nx: yes' } },
        { prepared_pcm: { sample_rate: 48000, channels: 2, bits: 32 } }, { accepted_frames: -1 }]) {
        const f = await fixture({ descriptor }); await expect(f.prepare()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_INVALID' });
    }
});
it.each(['header', 'generation', 'truncated', 'interrupted', 'overlong'])('rejects %s PCM without treating an arbitrary HTTP EOF as song ended', async kind => {
    const header = wave(); if (kind === 'header') header.writeUInt16LE(3, 20);
    const f = await fixture({ ...(kind === 'header' ? { header } : {}), ...(kind === 'generation' ? { httpGeneration: 2 } : {}),
        ...(kind === 'truncated' ? { body: Buffer.alloc(351) } : {}), ...(kind === 'interrupted' ? { reason: 'paused' } : {}), ...(kind === 'overlong' ? { body: Buffer.alloc(360) } : {}) });
    const ready = await f.prepare();
    const reading = (async () => { for await (const _ of f.client.openReadable('test-session')) {} })();
    await expect(reading).rejects.toMatchObject({ code: kind === 'header' || kind === 'generation' ? 'PCM_FORMAT_INVALID'
        : kind === 'truncated' ? 'PCM_TRUNCATED' : kind === 'overlong' ? 'PCM_DURATION_EXCEEDED' : 'PCM_INTERRUPTED' });
    expect(await ready.completed).toMatchObject({ kind: 'failed' });
});
it('pause aborts a pending body read, closes only its generation and requires new prepare for resuming', async () => {
    const f = await fixture({ hold: true }); const ready = await f.prepare();
    const reading = (async () => { for await (const _ of f.client.openReadable('test-session')) {} })();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'CANCELLED' }); await vi.waitFor(() => expect(f.request()).toBe(1));
    expect((await f.client.pause('test-session')).state).toBe('paused'); await rejected;
    expect(await ready.completed).toMatchObject({ kind: 'paused' }); expect(f.invoke.mock.calls).toContainEqual(['pcm', 'close', { generation: 1 }]);
    expect(() => f.client.openReadable('test-session')).toThrow('CANCELLED');
    expect((await f.prepare()).generation).toBe(2);
});
it('seek confirms official position independently then prepares a new paused generation', async () => {
    const f = await fixture(); await f.client.prepare({ session: 'test-session', trackId, durationMs: 1000 });
    const changed = await f.client.seek('test-session', 500); expect(changed.generation).toBe(2); expect(changed.positionMs).toBe(500);
    const operations = f.invoke.mock.calls.map((call: any[]) => call.slice(0, 2).join(':'));
    expect(operations.slice(-8)).toEqual(['pcm:close', 'soloist:status', 'soloist:pause', 'soloist:status', 'soloist:seek', 'soloist:pause', 'soloist:status', 'pcm:prepare']);
    expect(changed.actualQuality).toBeNull();
});
it('does not accept command acknowledgements as actual playing, pause or seek evidence', async () => {
    const f = await fixture({ ackOnly: true }); await expect(f.prepare()).rejects.toMatchObject({ code: 'TRACK_NOT_CURRENT' });
    expect(f.invoke.mock.calls.some((call: any[]) => call[0] === 'pcm')).toBe(false);
});
it('sanitizes arbitrary transport errors so a private URL and bearer cannot escape', async () => {
    const invoke = vi.fn(async () => { throw Object.assign(new Error('http://127.0.0.1:28802/pcm/private ' + bearer), { code: 'UNTRUSTED_PRIVATE' }); });
    const client = createSoloistPcmClient({ invoke }); cleanups.push(() => client.dispose());
    await expect(client.prepare({ session: 'test-session', trackId })).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Spotify Soloist: CONTROL_FAILED' });
});
it('a failed preparation stops only its fresh active expected SDK URI and preserves the primary error', async () => {
    const f = await fixture(); const original = f.invoke.getMockImplementation()!;
    await f.invoke('soloist', 'play', { expected_uri: uri }); f.invoke.mockClear();
    f.invoke.mockImplementationOnce(async () => { throw Object.assign(new Error('private_transport_response'), { code: 'CONTROL_FAILED' }); });
    f.invoke.mockImplementation(original);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Spotify Soloist: CONTROL_FAILED' });
    expect(f.playback()).toBe('paused');
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'pause')).toEqual([
        ['soloist', 'pause', { observe_seconds: 1, expected_uri: uri }],
    ]);
    expect(f.invoke.mock.calls.filter(call => call[0] === 'pcm' && call[1] === 'prepare')).toHaveLength(0);
});
it.each(['different-uri', 'inactive', 'logged-out'])('failed preparation cleanup does not pause a %s SDK source', async kind => {
    const f = await fixture(); await f.invoke('soloist', 'play', { expected_uri: uri }); f.invoke.mockClear();
    const changed = control('playing');
    if (kind === 'different-uri') changed.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`;
    if (kind === 'inactive') changed.evidence[0].is_active = false;
    if (kind === 'logged-out') changed.evidence[0].logged_in = false;
    f.invoke.mockImplementationOnce(async () => { throw Object.assign(new Error('private_transport_response'), { code: 'CONTROL_FAILED' }); });
    f.invoke.mockImplementation(async () => changed);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'CONTROL_FAILED' });
    expect(f.playback()).toBe('playing');
    expect(f.invoke.mock.calls.some(call => call[0] === 'soloist' && ['pause', 'play', 'seek'].includes(call[1]))).toBe(false);
});
it('waits read-only for an acknowledged official selection to reach the fresh SDK before any pause, seek or PCM generation', async () => {
    const f = await fixture({ selectionPollMs: 10 }); const original = f.invoke.getMockImplementation()!;
    let observations = 0, confirmed = false;
    f.invoke.mockImplementation(async (surface: string, operation: string, payload: Record<string, any>) => {
        if (surface === 'soloist' && operation === 'status' && observations++ < 2) {
            const old = control('playing'); old.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`; return old;
        }
        if (surface === 'soloist' && operation === 'status') confirmed = true;
        if (['pause', 'seek', 'prepare'].includes(operation)) expect(confirmed).toBe(true);
        return original(surface, operation, payload);
    });
    expect(await f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).toMatchObject({ generation: 1, state: 'prepared' });
    expect(observations).toBe(5); // Three selection snapshots followed by the two normal guarded paused snapshots.
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'pause')).toHaveLength(2);
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'seek')).toHaveLength(1);
});
it('a bounded unconfirmed selection times out with zero SDK mutation, including later source cleanup pause', async () => {
    const f = await fixture({ selectionTimeoutMs: 60, selectionPollMs: 10 });
    f.invoke.mockImplementation(async () => { const old = control('playing'); old.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`; return old; });
    await expect(f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
    const count = f.invoke.mock.calls.length;
    expect(await f.client.pause('test-session')).toMatchObject({ state: 'paused' });
    expect(f.invoke.mock.calls).toHaveLength(count);
    expect(f.invoke.mock.calls.every(call => call[0] === 'soloist' && call[1] === 'status')).toBe(true);
});
it('a selection observation window remains bounded if its injected transport ignores abort', async () => {
    const f = await fixture({ selectionTimeoutMs: 60, selectionPollMs: 10 });
    f.invoke.mockImplementation(() => new Promise(() => {}));
    await expect(f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
    expect(f.invoke).toHaveBeenCalledOnce();
});
it('waits only read-only while the acknowledged new URI activates after quality reload', async () => {
    const f = await fixture({ selectionPollMs: 10 }); const original = f.invoke.getMockImplementation()!;
    let snapshots = 0, activated = false;
    f.invoke.mockImplementation(async (surface: string, operation: string, payload: Record<string, any>) => {
        if (surface === 'soloist' && operation === 'status' && snapshots++ < 2) {
            const pending = control('playing'); pending.evidence[0].is_active = false; return pending;
        }
        if (surface === 'soloist' && operation === 'status') activated = true;
        if (['pause', 'seek', 'prepare'].includes(operation)) expect(activated).toBe(true);
        return original(surface, operation, payload);
    });
    expect(await f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).toMatchObject({ generation: 1 });
    expect(snapshots).toBe(5);
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'pause')).toHaveLength(2);
});
it('an inactive pending selection times out without mutating or cleanup-pausing the device', async () => {
    const f = await fixture({ selectionTimeoutMs: 60, selectionPollMs: 10 });
    f.invoke.mockImplementation(async () => { const pending = control('playing'); pending.evidence[0].is_active = false; return pending; });
    await expect(f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).rejects.toMatchObject({ code: 'PLAYBACK_STATE_UNCONFIRMED' });
    await f.client.pause('test-session');
    expect(f.invoke.mock.calls.every(call => call[0] === 'soloist' && call[1] === 'status')).toBe(true);
});
it('logout while awaiting activation still aborts immediately without any device mutation', async () => {
    const f = await fixture({ selectionPollMs: 10 }); let snapshots = 0;
    f.invoke.mockImplementation(async () => { const pending = control('playing'); pending.evidence[0].is_active = false;
        if (snapshots++) pending.evidence[0].logged_in = false; return pending; });
    await expect(f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(snapshots).toBe(2);
    expect(f.invoke.mock.calls.every(call => call[0] === 'soloist' && call[1] === 'status')).toBe(true);
});
it.each(['logged-out', 'invalid-uri'])('an acknowledged selection does not wait or mutate for %s SDK evidence', async kind => {
    const f = await fixture({ selectionPollMs: 10 }); const value = control('playing');
    if (kind === 'logged-out') value.evidence[0].logged_in = false;
    if (kind === 'invalid-uri') value.evidence[1].uri = 'untrusted';
    f.invoke.mockImplementation(async () => value);
    await expect(f.client.prepare({ session: 'test-session', trackId, selectionPending: true })).rejects.toMatchObject({
        code: kind === 'logged-out' ? 'AUTH_REQUIRED' : 'TRACK_NOT_CURRENT',
    });
    expect(f.invoke).toHaveBeenCalledOnce();
});
it('replacing a waiting selection cancels its readonly window without pausing the replacement URI', async () => {
    const f = await fixture({ selectionPollMs: 10 }); const original = f.invoke.getMockImplementation()!;
    let waiting = true;
    f.invoke.mockImplementation(async (surface: string, operation: string, payload: Record<string, any>) => {
        if (waiting && surface === 'soloist' && operation === 'status') { const old = control('playing'); old.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`; return old; }
        return original(surface, operation, payload);
    });
    const old = f.client.prepare({ session: 'old', trackId, selectionPending: true }), cancelled = expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalled());
    waiting = false; const current = f.client.prepare({ session: 'current', trackId, selectionPending: true });
    await cancelled; expect(await current).toMatchObject({ session: 'current', generation: 1 });
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'pause')).toHaveLength(2);
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === 'seek')).toHaveLength(1);
});
it('dispose aborts an unconfirmed selection without issuing any SDK mutation', async () => {
    const f = await fixture({ selectionPollMs: 10 });
    f.invoke.mockImplementation(async () => { const old = control('playing'); old.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`; return old; });
    const pending = f.client.prepare({ session: 'test-session', trackId, selectionPending: true }), cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalled()); f.client.dispose(); await cancelled;
    expect(f.invoke.mock.calls.every(call => call[0] === 'soloist' && call[1] === 'status')).toBe(true);
});
it('keeps a late cancelled prepare from replacing a newer session or opening its HTTP descriptor', async () => {
    const f = await fixture(); let complete!: (value: unknown) => void;
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (surface: string, operation: string, payload: Record<string, any>) => {
        if (surface === 'pcm' && operation === 'prepare' && !complete) return new Promise(resolve => { complete = resolve; });
        return original(surface, operation, payload);
    });
    const first = f.client.prepare({ session: 'first', trackId }); const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const second = f.client.prepare({ session: 'second', trackId });
    complete({ ...state(), url: `http://127.0.0.1:${f.port}/pcm/${'private-old'.padEnd(32, 'x')}`, headers: { Authorization: bearer } });
    await rejected; expect((await second).session).toBe('second');
    expect(() => f.client.openReadable('first')).toThrow('STALE_SESSION'); expect(f.request()).toBe(0);
});
it('cancel before the first read never opens HTTP and remains distinguishable from finite EOF', async () => {
    const f = await fixture(); const ready = await f.prepare(), abort = new AbortController(); abort.abort();
    const stream = f.client.openReadable('test-session', { signal: abort.signal });
    await expect(stream.next()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(f.request()).toBe(0);
    expect(await ready.completed).toMatchObject({ kind: 'cancelled' });
});
it('a consumer ending early releases its single reader without reporting song EOF', async () => {
    const f = await fixture({ hold: true }); const ready = await f.prepare();
    const stream = f.client.openReadable('test-session'); const pending = stream.next();
    await vi.waitFor(() => expect(f.request()).toBe(1));
    f.response()!.write(Buffer.alloc(8)); expect((await pending).value).toHaveLength(8);
    await stream.return(); expect(await ready.completed).toMatchObject({ kind: 'reader_disconnected' });
    expect(() => f.client.openReadable('test-session')).toThrow('READER_ALREADY_USED');
});
it.each([401, 403, 404])('maps HTTP %s safely rather than exposing URL or response text', async status => {
    const f = await fixture({ httpError: status }); await f.prepare();
    const stream = f.client.openReadable('test-session');
    await expect(stream.next()).rejects.toMatchObject({ code: status < 404 ? 'AUTH_REQUIRED' : 'PCM_SOURCE_UNAVAILABLE' });
});
it('does not leak even a known error code with an unsafe injected message', async () => {
    const f = await fixture({ fetchImpl: async () => { throw Object.assign(new Error('private-url ' + bearer), { code: 'AUTH_REQUIRED' }); } });
    await f.prepare();
    await expect(f.client.openReadable('test-session').next()).rejects.toMatchObject({ message: 'Spotify Soloist: AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
});
it('never trusts a caller position or PCM descriptor echo when official seek did not move', async () => {
    const f = await fixture({ ignoreSeek: true });
    await expect(f.client.prepare({ session: 'test-session', trackId, durationMs: 60000, positionMs: 40000 })).rejects.toMatchObject({ code: 'SEEK_UNCONFIRMED' });
    expect(f.invoke.mock.calls.some(call => call[0] === 'pcm' && call[1] === 'prepare')).toBe(false); expect(f.request()).toBe(0);
});
it.each(['play', 'pause'])('refuses %s before touching official playback if another track owns the device', async operation => {
    const f = await fixture(); await f.prepare();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (surface: string, action: string, payload: Record<string, any>) => {
        if (surface === 'soloist' && action === 'status') {
            const value = control(); value.evidence[1].uri = `spotify:track:${'z'.repeat(22)}`; return value;
        }
        return original(surface, action, payload);
    });
    f.invoke.mockClear();
    await expect(f.client[operation]('test-session')).rejects.toMatchObject({ code: 'TRACK_NOT_CURRENT' });
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === operation)).toHaveLength(0);
});
it.each(['play', 'pause'])('refuses %s on an inactive official device before mutation', async operation => {
    const f = await fixture(); await f.prepare();
    f.invoke.mockImplementation(async () => ({ evidence: [{ type: 'auth_state', logged_in: true, is_active: false },
        { type: 'playback_state', uri, status: 'paused', position_ms: 0 }] }));
    f.invoke.mockClear();
    await expect(f.client[operation]('test-session')).rejects.toMatchObject({ code: 'DEVICE_INACTIVE' });
    expect(f.invoke.mock.calls.filter(call => call[0] === 'soloist' && call[1] === operation)).toHaveLength(0);
});
it('binds every official playback mutation to the expected current URI in guest stdin', async () => {
    const f = await fixture(); await f.prepare(); await f.client.play('test-session'); await f.client.pause('test-session');
    const mutations = f.invoke.mock.calls.filter(call => call[0] === 'soloist' && ['play', 'pause', 'seek'].includes(call[1]));
    expect(mutations).toHaveLength(5);
    for (const call of mutations) expect(call[2]).toMatchObject({ expected_uri: uri });
});

it('releases a producer restarted by official seek before opening a fresh PCM generation', async () => {
    const f = await fixture({ seekStartsProducer: true });
    expect((await f.client.prepare({ session: 'test-session', trackId, durationMs: 1000 })).generation).toBe(1);
    const positioned = await f.client.seek('test-session', 500);
    expect(positioned).toMatchObject({ generation: 2, positionMs: 500, state: 'prepared' });
    const operations = f.invoke.mock.calls.map((call: any[]) => call.slice(0, 2).join(':'));
    expect(operations.slice(-4)).toEqual(['soloist:seek', 'soloist:pause', 'soloist:status', 'pcm:prepare']);
});
