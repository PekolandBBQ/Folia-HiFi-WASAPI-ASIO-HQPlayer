import { describe, expect, it } from 'vitest';
import { publishSignalPath, clearSignalPath, beginSignalPath, failSignalPath, useSignalPathStore } from '../../../src/stores/useSignalPathStore';
import type { NativeAudioState } from '../../../src/types/nativeAudio';
import { buildSignalPath } from '../../../src/components/audio/buildSignalPath';
import type { TFunction } from 'i18next';
import zh from '../../../src/i18n/locales/zh-CN';

// test/unit/nativeAudio/signalPath.test.ts — clock packets must not repeatedly render the disclosure.
describe('signal telemetry', () => {
    it('identifies the Spotify process source, explains the absent original tier and reports WAV separately', () => {
        const t = ((key: string) => key.split('.').reduce((value: any, part) => value?.[part], zh) || key) as TFunction;
        const state = {session:'source',backend:'hqplayer',deviceId:'hqplayer-local',channels:2,sampleRate:44100,
            requestedQuality:'hires' as const,preparedSource:true,sourceEncodingVerified:false,sourceOrigin:'spotify-process' as const,
            preparedAudio:{representation:'s32le',sampleRate:44100,channels:2,bitDepth:32},hqplayerInputContainer:'wav' as const};
        const rows = buildSignalPath(state,'hqplayer',t).rows;
        expect(rows.find(row=>row.title==='音源来源')?.value).toContain('专属进程采集');
        expect(rows.find(row=>row.title==='流媒体音源音质')?.value).toContain('原始音质档位未提供');
        expect(rows.find(row=>row.title==='流媒体音源音质')?.value).not.toContain('请求: HiRes');
        expect(rows.find(row=>row.title==='HQPlayer 输入封装')?.value).toContain('WAV · s32le');
        expect(rows[0].value).toBe(zh.signalPath.originalUnknown);
    });
    it('keeps a failed load explicit until retry and ignores failures from an older session', () => {
        beginSignalPath('failed');
        failSignalPath('failed', 'HQPLAYER_COMMAND_REJECTED');
        expect(useSignalPathStore.getState().failureCode).toBe('HQPLAYER_COMMAND_REJECTED');
        beginSignalPath('retry');
        failSignalPath('failed', 'DEVICE_UNAVAILABLE');
        expect(useSignalPathStore.getState().failureCode).toBeNull();
        clearSignalPath('failed');
        expect(useSignalPathStore.getState().owner).toBe('retry');
        clearSignalPath('retry');
    });
    it('labels PCM conversion and both DSD clock families from observed output', () => {
        const t = ((key: string) => key) as TFunction;
        const state = { session: 'format', backend: 'hqplayer', deviceId: 'hqplayer-local', channels: 2,
            sourceCodec: 'FLAC', sourceSampleRate: 44100, sampleRate: 384000, outputRateReported: true, outputMode: 'PCM' };
        expect(buildSignalPath(state, 'hqplayer', t).rows[2].value).toBe('PCM 44.1 kHz → PCM 384 kHz');
        expect(buildSignalPath({ ...state, sourceSampleRate: 48000, sampleRate: 49152000, outputMode: 'SDM' }, 'hqplayer', t).rows[2].value).toBe('PCM 48 kHz → DSD 1024');
        expect(buildSignalPath({ ...state, sampleRate: 45158400, outputMode: 'DSD' }, 'hqplayer', t).rows[2].value).toBe('PCM 44.1 kHz → DSD 1024');
        expect(buildSignalPath({ ...state, outputRateReported: false }, 'hqplayer', t).rows[2].value).toBe('signalPath.unknown');
    });
    it('ignores clock changes, publishes gain changes, and protects newer sessions', () => {
        const state: NativeAudioState = { session: 'one', position: 0, duration: 30, playing: true, ended: false,
            sampleRate: 96000, channels: 2, latency: 0.01, backend: 'asio', deviceId: 'test', effectiveGain: 1 };
        publishSignalPath(state);
        const snapshot = useSignalPathStore.getState().snapshot;
        publishSignalPath({ ...state, position: 20 });
        expect(useSignalPathStore.getState().snapshot).toBe(snapshot);
        publishSignalPath({ ...state, position: 21, bufferedStart: 20, bufferedEnd: 24, buffering: true, producerComplete: false });
        expect(useSignalPathStore.getState().snapshot).toBe(snapshot);
        publishSignalPath({ ...state, streaming: true });
        const streamingSnapshot = useSignalPathStore.getState().snapshot;
        expect(streamingSnapshot?.streaming).toBe(true);
        publishSignalPath({ ...state, streaming: true, position: 22, bufferedStart: 21, bufferedEnd: 29, buffering: false, producerComplete: true });
        expect(useSignalPathStore.getState().snapshot).toBe(streamingSnapshot);
        publishSignalPath({ ...state, session: 'two', effectiveGain: 0.5 });
        clearSignalPath('one');
        expect(useSignalPathStore.getState().snapshot?.effectiveGain).toBe(0.5);
        clearSignalPath('two');
        expect(useSignalPathStore.getState().snapshot).toBeNull();
    });
    it('distinguishes requested HiRes from actual lossless and verified 24/48 HiRes', () => {
        const t = ((key: string) => key.split('.').reduce((value: any, part) => value?.[part], zh) || key) as TFunction;
        const state = { session: 'quality', backend: 'asio', deviceId: 'dac', channels: 2, sampleRate: 384000,
            requestedQuality: 'hires' as const, sourceQuality: 'lossless' as const, sourceCodec: 'FLAC',
            sourceSampleRate: 44100, sourceBitsPerSample: 16, sourceEncodingVerified: true, outputFormat: 'PCM float32' };
        const fallback = buildSignalPath(state, 'asio', t);
        expect(fallback.rows.find(row => row.title === '流媒体音源音质')?.value).toBe('请求: HiRes · 实际返回: 无损');
        expect(fallback.rows[0].value).toBe('FLAC · 44.1 kHz · 16-bit');
        const hires = buildSignalPath({ ...state, sourceQuality: 'hires', sourceSampleRate: 48000, sourceBitsPerSample: 24 }, 'asio', t);
        expect(hires.rows.find(row => row.title === '流媒体音源音质')?.value).toBe('请求: HiRes · 实际返回: HiRes');
        expect(hires.brief).toBe('48 kHz / 24-bit');
    });
    it('does not present a generated float WAV as the unverified original source', () => {
        const t = ((key: string) => key) as TFunction;
        const state = { session: 'prepared', backend: 'asio', deviceId: 'dac', channels: 2, sampleRate: 44100,
            requestedQuality: 'high' as const, preparedSource: true, sourceEncodingVerified: false,
            sourceCodec: 'WAV', sourceSampleRate: 44100, sourceBitsPerSample: 32, sourceBitrate: 2822400, outputFormat: 'PCM float32' };
        const result = buildSignalPath(state, 'asio', t);
        expect(result.brief).toBe('signalPath.unknown');
        expect(result.rows[0].value).toBe('signalPath.originalUnknown');
        expect(result.rows.find(row => row.title === 'signalPath.streamingQuality')?.value).toContain('signalPath.returnedQuality: signalPath.unknown');
        expect(result.rows.find(row => row.title === 'signalPath.format')?.value).toBe('PCM float32');
    });
    it('describes the streaming PCM32 compatibility path without changing file, integer or HQPlayer processing', () => {
        const t = ((key: string) => key.split('.').reduce((value: any, part) => value?.[part], zh) || key) as TFunction;
        const state = { session: 'stream', backend: 'asio', deviceId: 'dac', channels: 2, sampleRate: 44100,
            streaming: true, processingMode: 'compatibility' as const, preparedSource: true, sourceEncodingVerified: false };
        const processing = (value: Parameters<typeof buildSignalPath>[0]) =>
            buildSignalPath(value, 'asio', t).rows.find(row => row.title === '音频处理')?.value;
        expect(processing(state)).toBe('PCM32 流式解码 → 浮点处理 → 设备格式');
        expect(processing({ ...state, streaming: false })).toBe('PCM24 准备 → 浮点处理 → 设备格式');
        expect(processing({ ...state, processingMode: 'integer-direct' })).toBe(zh.signalPath.integer);
        expect(processing({ ...state, backend: 'hqplayer' })).toBe(zh.signalPath.hqProcessing);
        expect(buildSignalPath(state, 'asio', t).rows[0].value).toBe(zh.signalPath.originalUnknown);
    });
    it.each(['asio', 'wasapi-exclusive', 'hqplayer', 'browser'])('separates known received PCM from an unreported original for %s', backend => {
        const t = ((key: string) => key.split('.').reduce((value: any, part) => value?.[part], zh) || key) as TFunction;
        const state = { session: 'received', backend, deviceId: 'dac', channels: 2, sampleRate: 44100,
            outputRateReported: true, outputFormat: backend === 'browser' ? 'Web Audio float32' : 'PCM32 integer direct',
            requestedQuality: 'lossless' as const, preparedSource: true, sourceEncodingVerified: false,
            preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 } };
        const result = buildSignalPath(state, backend, t);
        const row = (title: string) => result.rows.find(value => value.title === title)?.value;
        expect(result.brief).toBe('接收 PCM · 44.1 kHz / 32-bit');
        expect(row(zh.signalPath.source)).toBe(zh.signalPath.originalUnknown);
        expect(row(zh.signalPath.prepared)).toBe('s32le · 44.1 kHz · 32-bit · 2 ch');
        expect(row(zh.signalPath.preparedConversion)).toBe('PCM 44.1 kHz → PCM 44.1 kHz');
        expect(row(zh.signalPath.streamingQuality)).toBe('请求: 无损 · 实际返回: 未回报');
        if (backend === 'browser') {
            expect(row(zh.signalPath.processing)).toBe(zh.signalPath.browserProcessing);
            expect(row(zh.signalPath.output)).toBe(zh.signalPath.browser);
            expect(row(zh.signalPath.format)).toBe('Web Audio float32 · 44.1 kHz');
        }
        if (['browser', 'hqplayer'].includes(backend)) {
            const pending = buildSignalPath({ ...state, outputRateReported: false }, backend, t);
            expect(pending.rows.find(value => value.title === zh.signalPath.format)?.value).toBe('未回报');
            expect(pending.rows.find(value => value.title === zh.signalPath.preparedConversion)?.value).toBe('未回报');
        }
    });
});
