import { useEffect, type CSSProperties } from 'react';
import SignalPath from '../../src/components/audio/SignalPath';
import { publishSignalPath } from '../../src/stores/useSignalPathStore';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import type { NativeAudioState } from '../../src/types/nativeAudio';
import type { ProbeDefinition } from './definition';

// Show actual source facts in the real disclosure without starting a decoder, output or HQPlayer instance.
const base: NativeAudioState = { session: 'quality-probe', position: 0, duration: 220, playing: false, ended: false,
    backend: 'asio', deviceId: 'mock-output', channels: 2, latency: 0, sampleRate: 384000, outputFormat: 'PCM float32',
    requestedQuality: 'hires', sourceQuality: 'lossless', sourceCodec: 'FLAC', sourceSampleRate: 44100,
    sourceBitsPerSample: 16, sourceEncodingVerified: true };
function SourceQualityProbe() {
    useEffect(() => {
        useAudioSettingsStore.setState({ nativeAudioBackend: 'asio', showAudioSignalPath: true });
        usePlaybackStore.setState({ audioSrc: 'blob:quality-probe', currentSong: { id: 'quality-probe', name: 'Quality probe',
            artists: [], album: { id: 1, name: 'Probe' }, durationMs: 220000 } });
        publishSignalPath(base);
    }, []);
    return <div className="p-8" style={{ '--text-primary': '#f4f4f5', '--text-secondary': '#d4d4d8', color: '#f4f4f5' } as CSSProperties}>
        <button onClick={() => publishSignalPath(base)}>Fallback lossless</button>
        <button onClick={() => publishSignalPath({ ...base, sourceQuality: 'hires', sourceSampleRate: 48000, sourceBitsPerSample: 24 })}>Verified HiRes</button>
        <button onClick={() => publishSignalPath({ ...base, requestedQuality: 'high', sourceQuality: undefined,
            preparedSource: true, sourceEncodingVerified: false, sourceCodec: 'WAV', sourceBitsPerSample: 32 })}>Prepared unknown</button>
        <SignalPath />
    </div>;
}
export default { id: 'sourceQuality', title: 'Source quality', description: 'Requested tiers and original formats stay separate from output precision',
    Component: SourceQualityProbe } satisfies ProbeDefinition;
