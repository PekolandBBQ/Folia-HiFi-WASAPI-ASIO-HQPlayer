import { describe, expect, it } from 'vitest';
import { publishSignalPath, clearSignalPath, useSignalPathStore } from '../../../src/stores/useSignalPathStore';
import type { NativeAudioState } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/signalPath.test.ts — clock packets must not repeatedly render the disclosure.
describe('signal telemetry', () => {
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
