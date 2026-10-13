import React, { useEffect } from 'react';
import SignalPath from '../../src/components/audio/SignalPath';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { useThemeSettingsStore } from '../../src/stores/useThemeSettingsStore';
import { publishSignalPath, clearSignalPath } from '../../src/stores/useSignalPathStore';
import { rememberAudioSourceQuality } from '../../src/services/onlineMusic/audioSourceQuality';
import type { SongResult } from '../../src/types';
import type { ProbeDefinition } from './definition';
import '../../src/i18n/config';

// dev/probes/signalPathBrowser.probe.tsx — synthetic metadata only; no audio or provider requests.
const song = { id: 'signal-probe', name: 'Signal telemetry', artists: [], album: { id: 0, name: 'Probe', picUrl: '' },
    durationMs: 60000, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'signal-probe' } } as SongResult;
const session = 'signal-path-probe';
function selectSource(ordinary = false) {
    const url = ordinary ? 'probe://ordinary-browser' : 'probe://received-pcm';
    if (!ordinary) rememberAudioSourceQuality(song, { url, fetchedAt: 0, requestedQuality: 'lossless', playbackTransport: 'soloist-pcm' });
    usePlaybackStore.setState({ currentSong: song, audioSrc: url });
    useAudioSettingsStore.setState({ nativeAudioBackend: 'browser', showAudioSignalPath: true });
    publishSignalPath({ session, backend: 'browser', deviceId: '', position: 0, duration: 60, playing: true, ended: false,
        sampleRate: 44100, channels: 2, latency: 0, outputRateReported: true, outputFormat: 'Web Audio float32',
        preparedSource: true, sourceEncodingVerified: false, requestedQuality: 'lossless', effectiveGain: 1,
        preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 } });
}
const SignalPathBrowserProbe = () => {
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    useEffect(() => { selectSource(); return () => clearSignalPath(session); }, []);
    return <div className="h-screen" style={{ background: daylight ? '#e8e8ec' : '#24262b',
        color: daylight ? '#27272a' : '#f4f4f5', '--text-primary': daylight ? '#27272a' : '#f4f4f5' } as React.CSSProperties}>
        <div className="flex gap-4 p-6">
            <button onClick={() => useThemeSettingsStore.setState({ isDaylight: !daylight })}>Theme</button>
            <button onClick={() => selectSource(true)}>Ordinary browser</button>
            <button onClick={() => selectSource()}>Spotify browser</button>
            <button onClick={() => useAudioSettingsStore.setState({ showAudioSignalPath: false })}>Hide signal</button>
        </div>
        <SignalPath />
    </div>;
};
export default { id: 'signalPathBrowser', title: 'Browser received PCM signal path',
    description: 'Unknown original encoding stays separate from known received PCM and Web Audio format.',
    Component: SignalPathBrowserProbe } satisfies ProbeDefinition;
