import { describe, expect, it } from 'vitest';
import { publishSignalPath, clearSignalPath, beginSignalPath, failSignalPath, useSignalPathStore } from '../../../src/stores/useSignalPathStore';
import type { NativeAudioState } from '../../../src/types/nativeAudio';
import { buildSignalPath } from '../../../src/components/audio/buildSignalPath';
import type { TFunction } from 'i18next';

// test/unit/nativeAudio/signalPath.test.ts — clock packets must not repeatedly render the disclosure.
describe('signal telemetry', () => {
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
        publishSignalPath({ ...state, session: 'two', effectiveGain: 0.5 });
        clearSignalPath('one');
        expect(useSignalPathStore.getState().snapshot?.effectiveGain).toBe(0.5);
        clearSignalPath('two');
        expect(useSignalPathStore.getState().snapshot).toBeNull();
    });
});
