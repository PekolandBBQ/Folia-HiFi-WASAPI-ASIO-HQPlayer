import { expect, it, describe, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { once } from 'node:events';
import { unzipSync } from 'fflate';

// test/unit/nativeAudio/hqplayerWavListening.test.ts — exact shipping queue/worker with a WAV-only HTTP envelope.
const require = createRequire(import.meta.url);
const { wavHeader, liveDataLimit, createWavPcmSource } = require('../../../electron/hqplayer/wavPcmSource.cjs');
const { patchWavWorker } = require('../../../packaging/exclusive/buildWavListeningComponent.cjs');
const { withWavCandidate } = require('../../../electron/hqplayer/wavCandidateManager.cjs');
const { LIVE_PCM_TRANSPORT } = require('../../../electron/nativeAudio/livePcmFormat.cjs');
const archive = path.resolve(process.env.FOLIA_WAV_BASELINE || '../artifacts/Folia-HiFi-r8-20261020/win-unpacked/resources/exclusive-native-audio/folia-hqplayer-0.1.4-preview.7-win32-x64.zip');

it('declares PCM32 extensible metadata, unknown live lengths and exact aligned final lengths', () => {
    const header = wavHeader(44100,2);
    expect(header.length).toBe(68); expect(header.toString('ascii',0,4)).toBe('RIFF');
    expect(header.toString('ascii',8,16)).toBe('WAVEfmt ');
    expect(header.readUInt32LE(16)).toBe(40);
    expect(header.readUInt16LE(20)).toBe(0xfffe); expect(header.readUInt16LE(22)).toBe(2);
    expect(header.readUInt32LE(24)).toBe(44100); expect(header.readUInt32LE(28)).toBe(352800);
    expect(header.readUInt16LE(32)).toBe(8); expect(header.readUInt16LE(34)).toBe(32);
    expect(header.readUInt16LE(36)).toBe(22); expect(header.readUInt16LE(38)).toBe(32); expect(header.readUInt32LE(40)).toBe(3);
    expect(header.subarray(44,60).toString('hex')).toBe('0100000000001000800000aa00389b71');
    expect(header.toString('ascii',60,64)).toBe('data');
    expect(header.readUInt32LE(4)).toBe(0xffffffff); expect(header.readUInt32LE(64)).toBe(0xffffffff);
    expect(liveDataLimit(2)%8).toBe(0);
    expect(wavHeader(44100,2,80).readUInt32LE(4)).toBe(140);
    expect(wavHeader(44100,2,80).readUInt32LE(64)).toBe(80);
    expect(()=>wavHeader(44100,2,81)).toThrow();
});
it('never overrides a normal build or modifies installed component state', async () => {
    const manager = { status:vi.fn(), install:vi.fn() };
    expect(withWavCandidate(manager,{app:{isPackaged:true},release:{candidate:'other'}})).toBe(manager);
    expect(withWavCandidate(manager,{app:{isPackaged:false},release:{candidate:'spotify-home-wav-listening'}})).toBe(manager);
    const candidate = withWavCandidate(manager,{app:{isPackaged:true},release:{candidate:'spotify-home-wav-listening'},resourcesPath:path.resolve('build/no-component')});
    expect(await candidate.status()).toMatchObject({available:false,version:'0.1.4-preview.7',inputContainer:'wav'});
    await expect(candidate.install()).rejects.toThrow('不更改'); expect(manager.status).not.toHaveBeenCalled(); expect(manager.install).not.toHaveBeenCalled();
});
it('refuses an unknown worker baseline instead of patching arbitrary component text', () => {
    expect(()=>patchWavWorker('unknown')).toThrow('baseline');
});
it.each([[2, 'hqplayer-wav-readfix'], [3, 'hqplayer-wav-addressfix'], [4, 'hqplayer-wav-tailfix']] as const)('selects the isolated WAV worker for revision %s', async (revision, directory) => {
    const candidate = withWavCandidate({}, { app: { isPackaged: true }, resourcesPath: path.resolve('build/no-component'),
        release: { candidate: 'spotify-home-wav-listening', wavHttpRevision: revision } });
    expect((await candidate.status()).executable).toBe(path.resolve('build/no-component', directory, 'hqplayer-component.cjs'));
});

describe.skipIf(!fs.existsSync(archive))('local listening assembly using the released r8 HQPlayer worker', () => {
    function component() {
        const files = unzipSync(fs.readFileSync(archive));
        const source = patchWavWorker(Buffer.from(files['hqplayer-component.cjs']).toString('utf8'));
        const module = {exports:{} as any};
        const candidateRequire = (id:string) => id === './wavPcmSource.cjs' ? {createWavPcmSource} : require(id);
        vm.runInNewContext(source + '\nmodule.exports = { ...require_hqplayerPcmSource(), ...require_hqplayerStreaming() };', {
            module, require:candidateRequire, __dirname:path.dirname(archive), Buffer, URL, AbortController,
            setTimeout,clearTimeout,setInterval,clearInterval,console,
            process:{...process, parentPort:undefined, on:()=>{}, send:()=>{}},
        });
        return module.exports;
    }
    it('changes only the container: WAV payload equals RAW byte for byte, including signed edge samples', async () => {
        const {PcmLoopbackSource} = component(), Wav = createWavPcmSource(PcmLoopbackSource);
        const pcm = Buffer.alloc(80); const values = [0,-2147483648,2147483647,-1,42,-42,0,10000,-10000,1];
        for(let i=0;i<20;i++)pcm.writeInt32LE(values[i%values.length],i*4);
        const read = async (Source:any) => {
            const input = new Source({rate:44100,channels:2,format:'int32le',bufferSeconds:6});
            try {
                const uri = await input.start(); const head = await fetch(uri,{method:'HEAD'});
                expect(head.headers.get('content-length')).toBeNull();
                await input.write(pcm); input.end();
                const response = await fetch(uri); const bytes = Buffer.from(await response.arrayBuffer());
                expect(input.state.sentBytes).toBe(pcm.length); expect(input.state.queuedBytes).toBe(0);
                return {bytes,type:response.headers.get('content-type')};
            } finally { await input.close(); }
        };
        const raw = await read(PcmLoopbackSource), wav = await read(Wav);
        expect(raw.type).toBe('application/x-hqplayer-raw'); expect(wav.type).toBe('audio/wav');
        expect(wav.bytes.subarray(0,68)).toEqual(wavHeader(44100,2,pcm.length));
        expect(wav.bytes.subarray(68)).toEqual(raw.bytes); expect(raw.bytes).toEqual(pcm);
    });
    it('spools bounded aligned writes without requiring a reader, and cancels only on owned stop', async () => {
        const {PcmLoopbackSource} = component(), Wav = createWavPcmSource(PcmLoopbackSource);
        const source = new Wav({rate:8000,channels:2,bufferSeconds:0.01,maximumChunkBytes:640});
        try {
            const uri = await source.start();
            expect((await fetch(uri,{headers:{Range:'bytes=999-'}})).status).toBe(503);
            await source.write(Buffer.alloc(640));
            await source.write(Buffer.alloc(8));
            expect(source.state.queuedBytes).toBe(648);
            const temporary = source.store.directory;
            await source.close(); expect(fs.existsSync(temporary)).toBe(false);
            await expect(source.write(Buffer.alloc(8))).rejects.toMatchObject({code:'CANCELLED'});
        } finally {await source.close();}
    });
    it('uses WAV only for owned live PCM, keeps raw wire identity, and resets with a fresh WAV header', async () => {
        const {createHQPlayerStreaming} = component();
        const loaded:any[] = [], errors:any[] = [];
        const host = { stop:vi.fn(async()=>{}),setStreamBuffered:()=>{},setStreamDuration:()=>{},
            load:vi.fn(async (spec:any)=>{ loaded.push(spec); return {session:spec.session,streamGeneration:spec.stream.generation,
                receiverInput:{sampleRate:44100,channels:2,containerBits:32},position:spec.stream.origin,playing:false}; }) };
        const diagnostics:any[]=[];
        const streaming = createHQPlayerStreaming({host,onError:(e:any)=>errors.push(e),onDiagnostic:(detail:any)=>diagnostics.push(detail)});
        const base = {session:'wav-integration',sampleRate:44100,channels:2,bits32:true,durationHint:180,transport:LIVE_PCM_TRANSPORT};
        let socket:net.Socket|undefined;
        try {
            let status = await streaming.prepare(base);
            expect(status.transport.framing).toBe('raw'); expect(status.inputContainer).toBe('wav');
            await vi.waitFor(()=>expect(loaded).toHaveLength(1));
            const response = await fetch(loaded[0].filePath); const reader = response.body!.getReader();
            expect(Buffer.from((await reader.read()).value!)).toEqual(wavHeader(44100,2));
            socket = net.createConnection(status.pipeName); await once(socket,'connect');
            const pcm = Buffer.alloc(80,37); socket.write(pcm);
            expect(Buffer.from((await reader.read()).value!)).toEqual(pcm);
            await vi.waitFor(()=>expect(streaming.status(base.session).decodedFrames).toBe(10));
            status = await streaming.reset({...base,generation:status.generation,position0:30}); socket.destroy();
            expect(status.inputContainer).toBe('wav'); expect(status.position0).toBe(30);
            expect(loaded[1].filePath).not.toBe(loaded[0].filePath);
            expect((await fetch(loaded[1].filePath,{method:'HEAD'})).headers.get('content-type')).toBe('audio/wav');
            expect(diagnostics.find(d=>d.phase==='request'&&d.session===base.session&&d.streamGeneration===2)).toBeDefined();
            await streaming.close(base.session,status.generation);
            const finite = await streaming.prepare({session:'finite',sampleRate:44100,channels:2,bits32:true,durationHint:180});
            expect(finite.inputContainer).toBeUndefined(); expect(loaded[2].filePath.endsWith('.wav')).toBe(false);
            await streaming.close('finite'); expect(errors).toEqual([]);
        } finally {socket?.destroy();await streaming.close();}
    });
    it('keeps WAV and the session open after input EOF and flushes the full reported DSP delay above three seconds', async () => {
        const {createHQPlayerStreaming} = component(), loaded:any[] = [], diagnostics:any[] = [], errors:any[] = [];
        const latency = 5.5;
        const host = { stop:vi.fn(async()=>{}),setStreamBuffered:vi.fn(),setStreamDuration:vi.fn(),
            load:vi.fn(async(spec:any)=>{loaded.push(spec);return {session:spec.session,streamGeneration:spec.stream.generation,
                receiverInput:{sampleRate:44100,channels:2,containerBits:32},position:0,latency,playing:true};}) };
        const streaming = createHQPlayerStreaming({host,onError:(e:any)=>errors.push(e),onDiagnostic:(d:any)=>diagnostics.push(d)});
        let socket:net.Socket|undefined;
        try {
            const status = await streaming.prepare({session:'tail-drain',sampleRate:44100,channels:2,bits32:true,
                durationHint:120,transport:LIVE_PCM_TRANSPORT});
            await vi.waitFor(()=>expect(loaded).toHaveLength(1));
            socket = net.createConnection(status.pipeName);await once(socket,'connect');
            const pcm = Buffer.alloc(80,23);socket.end(pcm);
            await vi.waitFor(()=>expect(diagnostics.some(d=>d.phase==='producer-complete')).toBe(true));
            const flushFrames = Math.ceil((latency+.25)*44100);
            expect(diagnostics).toContainEqual(expect.objectContaining({phase:'pcm-input-complete',capturedFrames:10,
                reportedOutputDelaySeconds:latency,flushFrames}));
            const wav = Buffer.from(await (await fetch(loaded[0].filePath)).arrayBuffer());
            expect(wav.length).toBe(68+pcm.length+flushFrames*8);
            expect(wav.subarray(68,148)).toEqual(pcm);
            expect(wav.subarray(148).every(byte=>byte===0)).toBe(true);
            expect(streaming.status('tail-drain').producerComplete).toBe(true);
            expect(host.stop).not.toHaveBeenCalled(); expect(errors).toEqual([]);
            // Reader completion is input consumption, not an audible-end receipt.
            expect(diagnostics.find(d=>d.phase==='reader-close')).toMatchObject({reason:'completed',sourceRetained:true});
        } finally {socket?.destroy();await streaming.close();}
    });
});
