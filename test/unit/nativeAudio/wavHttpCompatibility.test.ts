import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { once } from 'node:events';
import { unzipSync } from 'fflate';

// test/unit/nativeAudio/wavHttpCompatibility.test.ts — real sockets/files, synthetic receiver probes, no user playback.
const require = createRequire(import.meta.url);
const { createWavPcmSource, wavHeader } = require('../../../electron/hqplayer/wavPcmSource.cjs');
const { patchWavWorker } = require('../../../packaging/exclusive/buildWavListeningComponent.cjs');
const { LIVE_PCM_TRANSPORT } = require('../../../electron/nativeAudio/livePcmFormat.cjs');
const archive = path.resolve('../artifacts/Folia-HiFi-r8-20261020/win-unpacked/resources/exclusive-native-audio/folia-hqplayer-0.1.4-preview.7-win32-x64.zip');
function component() {
    const files = unzipSync(fs.readFileSync(archive));
    const source = patchWavWorker(Buffer.from(files['hqplayer-component.cjs']).toString('utf8'));
    const module = { exports: {} as any };
    vm.runInNewContext(source + '\nmodule.exports={...require_hqplayerPcmSource(),...require_hqplayerStreaming()};', {
        module, require: (id: string) => id === './wavPcmSource.cjs' ? { createWavPcmSource } : require(id),
        __dirname: path.dirname(archive), Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console,
        process: { ...process, parentPort: undefined, on: () => {}, send: () => {} },
    });
    return module.exports;
}
async function fixture(run: (source: any, url: string, events: any[]) => Promise<void>) {
    const { PcmLoopbackSource } = component(), events: any[] = [];
    const source = new (createWavPcmSource(PcmLoopbackSource))({ rate: 44100, channels: 2, onDiagnostic: (event: any) => events.push(event) });
    try { await run(source, await source.start(), events); }
    finally { await source.close(); expect(fs.existsSync(source.store.directory)).toBe(false); }
}
async function rawRequest(url: string, target: string, headers: string[], version = '1.1', method = 'HEAD') {
    const address = new URL(url), chunks: Buffer[] = [];
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(address.port) });
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP request did not terminate')));
    try {
        await once(socket, 'connect');
        socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
        const ended = once(socket, 'end');
        socket.write(`${method} ${target} HTTP/${version}\r\n${[...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`);
        await ended;
        const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
        return { status: Number(bytes.toString('ascii', 0, split).split(' ')[1]), body: bytes.subarray(split + 4) };
    } finally { socket.destroy(); }
}
it.skipIf(!fs.existsSync(archive))('serves local Host/absolute-target/HTTP-1.0 probes before PCM, then replays exact bytes', async () => fixture(async (source, url, events) => {
    const pathname = new URL(url).pathname;
    for (const [target, headers, version] of [
        [pathname, [], '1.0'], [pathname, ['Host: 127.0.0.1'], '1.1'],
        [url, [`Host: LOCALHOST:${new URL(url).port}`], '1.1'],
        [pathname.slice(0, -4), ['Host: localhost'], '1.1'],
        [pathname.replace(source.token[0], `%${source.token.charCodeAt(0).toString(16)}`) + '?probe=private-value', ['Host: [::1]'], '1.1'],
    ] as const) {
        const response = await rawRequest(url, target, [...headers], version);
        expect(response.status).toBe(200); expect(response.body.length).toBe(0);
    }
    const pcm = Buffer.alloc(800, 37); await source.write(pcm); source.end();
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await rawRequest(url, url, ['Host: 127.0.0.1'], '1.1', 'GET');
        expect(response.status).toBe(200); expect(response.body).toEqual(Buffer.concat([wavHeader(44100, 2, pcm.length), pcm]));
    }
    expect(source.state.closed).toBe(false);
    const requests = events.filter(event => event.phase === 'request');
    expect(requests).toHaveLength(7); expect(requests.every(event => event.addressAccepted)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(source.token); expect(JSON.stringify(events)).not.toContain('private-value');
}));
it.skipIf(!fs.existsSync(archive))('isolates wrong credentials/Host/port refusals and still accepts the next valid reader', async () => fixture(async (source, url, events) => {
    const address = new URL(url), port = Number(address.port), pathname = address.pathname;
    for (const [target, host, reason] of [
        ['/wrong.wav', `127.0.0.1:${port}`, 'path-mismatch'],
        [pathname, 'example.com', 'host-not-loopback'],
        [pathname, `localhost:${port + 1}`, 'host-port-mismatch'],
        [`http://example.com:${port}${pathname}`, 'localhost', 'absolute-host-not-loopback'],
    ]) {
        expect((await rawRequest(url, target, [`Host: ${host}`])).status).toBe(404);
        expect(events.filter(event => event.phase === 'response').at(-1)).toMatchObject({ status: 404, reason });
        expect(source.closed).toBe(false);
    }
    expect((await rawRequest(url, pathname, [`Host: localhost:${port}`])).status).toBe(200);
    const pcm = Buffer.alloc(160, 41); await source.write(pcm); source.end();
    const response = await fetch(url); expect(Buffer.from(await response.arrayBuffer()).subarray(68)).toEqual(pcm);
    expect(events.filter(event => event.phase === 'reader-close').every(event => event.sourceRetained)).toBe(true);
}));
it.skipIf(!fs.existsSync(archive))('supports HEAD, RIFF/fmt/data probes and replay without consuming or closing the source', async () => fixture(async (source, url, events) => {
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-length')).toBeNull();
    const header = wavHeader(44100, 2);
    for (const [start, end] of [[0, 11], [12, 59], [60, 67]]) {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/*`);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(header.subarray(start, end + 1));
    }
    const pcm = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    await source.write(pcm);
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, { headers: { Range: 'bytes=68-323' } });
        expect(Buffer.from(await response.arrayBuffer())).toEqual(pcm);
    }
    expect(source.state.closed).toBe(false); expect(source.state.queuedBytes).toBe(256);
    expect(events.filter(event => event.phase === 'reader-close').every(event => event.sourceRetained)).toBe(true);
}));
it.skipIf(!fs.existsSync(archive))('survives a disconnected probe and concurrently replays unchanged PCM through the producer end', async () => fixture(async (source, url, events) => {
    const abandoned = await fetch(url), probe = abandoned.body!.getReader();
    expect(Buffer.from((await probe.read()).value!)).toEqual(wavHeader(44100, 2));
    await probe.cancel();
    await vi.waitFor(() => expect(events.some(e => e.phase === 'reader-close' && e.reason === 'peer-disconnected')).toBe(true));
    expect(source.closed).toBe(false);
    const a = await fetch(url), b = await fetch(url), readA = a.arrayBuffer(), readB = b.arrayBuffer();
    expect(a.headers.get('transfer-encoding')).toBeNull(); expect(a.headers.get('content-length')).toBeNull();
    const pcm = Buffer.alloc(800); for (let i = 0; i < pcm.length / 4; i++) pcm.writeInt32LE(i % 2 ? -2147483648 : 2147483647, i * 4);
    await source.write(pcm); source.end();
    const bytesA = Buffer.from(await readA), bytesB = Buffer.from(await readB);
    expect(bytesA.subarray(68)).toEqual(pcm); expect(bytesB).toEqual(bytesA);
    expect(source.state.sentBytes).toBe(pcm.length);
    const replay = await fetch(url), completed = Buffer.from(await replay.arrayBuffer());
    expect(completed.subarray(0, 68)).toEqual(wavHeader(44100, 2, pcm.length));
    expect(completed.subarray(68)).toEqual(pcm); expect(Number(replay.headers.get('content-length'))).toBe(868);
    expect(events.find(e => e.phase === 'producer-complete')).toMatchObject({ capturedBytes: 800, fileBytes: 868, lengthKind: 'exact' });
}));
it.skipIf(!fs.existsSync(archive))('serves cross-header, clipped, open and suffix byte ranges with truthful lengths', async () => fixture(async (source, url) => {
    const pcm = Buffer.alloc(160, 37); await source.write(pcm);
    let response = await fetch(url, { headers: { Range: 'bytes=1000-' } });
    expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('1');
    expect((await fetch(url, { headers: { Range: 'bytes=-16' } })).status).toBe(503);
    response = await fetch(url, { headers: { Range: 'bytes=60-9999' } });
    expect(response.headers.get('content-range')).toBe('bytes 60-227/*');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat([wavHeader(44100, 2).subarray(60), pcm]));
    source.end(); const bytes = Buffer.concat([wavHeader(44100, 2, 160), pcm]);
    for (const [range, start, end] of [['bytes=60-75', 60, 75], ['bytes=68-', 68, 227], ['bytes=-16', 212, 227], ['bytes=0-9999', 0, 227]] as const) {
        response = await fetch(url, { headers: { Range: range } });
        expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/228`);
        expect(Number(response.headers.get('content-length'))).toBe(end - start + 1);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    for (const range of ['bytes=228-', 'bytes=-0', 'bytes=3-2', 'bytes=0-2,4-5', 'bytes=9007199254740992-']) {
        response = await fetch(url, { headers: { Range: range } }); expect(response.status).toBe(416);
        expect(response.headers.get('content-range')).toBe('bytes */228');
    }
}));
it.skipIf(!fs.existsSync(archive))('owned stop interrupts waiting readers, removes only its temporary PCM and rejects later writes', async () => fixture(async (source, url, events) => {
    const response = await fetch(url), reader = response.body!.getReader(); await reader.read();
    const next = reader.read().catch(() => null); const ownDirectory = source.store.directory;
    await source.close(); const terminal = await next;
    expect(terminal === null || terminal.done).toBe(true);
    await expect(source.write(Buffer.alloc(8))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fs.existsSync(ownDirectory)).toBe(false);
    expect(events.some(e => e.phase === 'reader-close' && e.reason === 'owner-stop' && !e.sourceRetained)).toBe(true);
    expect(events.some(e => e.phase === 'cache-close' && e.removed)).toBe(true);
}));
it.skipIf(!fs.existsSync(archive))('does not deadlock preparation when the receiver probes and reconnects before the PCM pipe opens', async () => {
    const { createHQPlayerStreaming } = component(), loaded: any[] = [], events: any[] = [], errors: any[] = [];
    const host = { stop: vi.fn(async () => {}), setStreamBuffered: () => {}, setStreamDuration: () => {},
        load: async (spec: any) => {
            loaded.push(spec);
            for (const range of ['bytes=0-11', 'bytes=12-59', 'bytes=60-67']) {
                const response = await fetch(spec.filePath, { headers: { Range: range } });
                expect(response.status).toBe(206); await response.arrayBuffer();
            }
            const probe = await fetch(spec.filePath); await probe.body!.cancel();
            return { session: spec.session, streamGeneration: spec.stream.generation,
                receiverInput: { sampleRate: 44100, channels: 2, containerBits: 32 }, position: 0, playing: false };
        } };
    const streaming = createHQPlayerStreaming({ host, onDiagnostic: (e: any) => events.push(e), onError: (e: any) => errors.push(e) });
    const spec = { session: 'receiver-reconnect', sampleRate: 44100, channels: 2, bits32: true, durationHint: 180, transport: LIVE_PCM_TRANSPORT };
    let socket: net.Socket | undefined;
    try {
        let status = await streaming.prepare(spec);
        await vi.waitFor(() => { status = streaming.status(spec.session); expect(status.ready).toBe(true); });
        socket = net.createConnection(status.pipeName); await once(socket, 'connect');
        const pcm = Buffer.alloc(800, 19); socket.write(pcm);
        await vi.waitFor(() => expect(streaming.status(spec.session).decodedFrames).toBe(100));
        const response = await fetch(loaded[0].filePath, { headers: { Range: 'bytes=68-867' } });
        expect(Buffer.from(await response.arrayBuffer())).toEqual(pcm);
        expect(errors).toEqual([]);
        expect(events.some(e => e.session === spec.session && e.streamGeneration === status.generation && e.phase === 'request')).toBe(true);
    } finally { socket?.destroy(); await streaming.close(); }
});
