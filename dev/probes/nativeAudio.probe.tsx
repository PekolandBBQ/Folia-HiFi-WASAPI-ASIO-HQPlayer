import SignalPath from '../../src/components/audio/SignalPath';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import HQPlayerSettingsSection from '../../src/components/modal/settings/HQPlayerSettingsSection';
import NativeAudioSettingsSection from '../../src/components/modal/settings/NativeAudioSettingsSection';
import PlaybackDeck from '../../src/components/app/playback/PlaybackDeck';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';
import { useNativeAudioRecovery } from '../../src/hooks/useNativeAudioRecovery';
import NativeAudioRecoveryDialog from '../../src/components/audio/NativeAudioRecoveryDialog';
import { PlayerState } from '../../src/types';

// dev/probes/nativeAudio.probe.tsx — real React lifecycle with a test-injected native bridge.
function silentLocalFile() {
    const rate = 48000, size = rate * 6 * 10;
    const bytes = new Uint8Array(44 + size), view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
    text(0, 'RIFF'); view.setUint32(4, size + 36, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 6, true); view.setUint16(32, 6, true);
    view.setUint16(34, 24, true); text(36, 'data'); view.setUint32(40, size, true);
    return new File([bytes], 'silence.wav', { type: 'audio/wav' });
}
function NativeAudioProbe({ hqplayer = false }: { hqplayer?: boolean } = {}) {
    const sourceKind = new URLSearchParams(location.search).get('sourceKind');
    const remoteUrl = new URLSearchParams(location.search).get('audioUrl');
    const backend = useAudioSettingsStore(state => state.nativeAudioBackend);
    const device = useAudioSettingsStore(state => state.nativeAudioDeviceId);
    const processingMode = useAudioSettingsStore(state => state.nativeAudioProcessingMode);
    const audio = useRef<HTMLAudioElement | null>(null);
    const recover = useNativeAudioRecovery(audio, backend !== 'browser');
    const register = useCallback((element: HTMLAudioElement | null) => { audio.current = element; }, []);
    const [status, setStatus] = useState('waiting');
    const autoplaySpent = useRef(false);
    useEffect(() => {
        if (localStorage.getItem('native_probe_autoplay') !== 'true' || autoplaySpent.current) return;
        autoplaySpent.current = true;
        void audio.current?.play().catch(error => setStatus(error.name));
    }, []);
    const [source, setSource] = useState(() => sourceKind === 'remote' && remoteUrl ? remoteUrl : URL.createObjectURL(silentLocalFile()));
    const revocations = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    useEffect(() => {
        // StrictMode's simulated unmount must not revoke the still-active source.
        clearTimeout(revocations.current.get(source));
        revocations.current.delete(source);
        return () => { revocations.current.set(source, setTimeout(() => {
            URL.revokeObjectURL(source); revocations.current.delete(source);
        }, 0)); };
    }, [source]);
    useEffect(() => {
        const song = { id: 'native-probe', name: 'Native probe', artists: [],
            album: { id: 'probe', name: 'Probe', picUrl: '' }, durationMs: 10000, localRef: { songId: 'probe' }, isLocal: true };
        usePlaybackStore.setState({ audioSrc: source, currentSong: song });
    }, [source]);
    const clock = useMotionValue(0);
    const label = useTransform(clock, value => value.toFixed(2));
    return <div className="mx-auto max-w-xl space-y-5 p-8" style={{ color: 'var(--text-primary)' }}>
        {hqplayer && <HQPlayerSettingsSection className="border-white/20" />}
        <NativeAudioSettingsSection isDaylight={false} theme={DEFAULT_THEME} className="rounded-xl border border-white/20 p-5" />
        <PlaybackDeck register={register} nativeBackend={backend} nativeDeviceId={device} src={source}
            nativeProcessingMode={processingMode}
            getLocalFile={async () => sourceKind ? null : silentLocalFile()}
            onLoadedMetadata={() => setStatus('ready')}
            onPlay={() => { setStatus('playing'); usePlaybackStore.setState({ playerState: PlayerState.PLAYING }); }} onPause={() => setStatus('paused')}
            onTimeUpdate={event => clock.set(event.currentTarget.currentTime)}
            onSeeked={event => clock.set(event.currentTarget.currentTime)}
            onError={event => { setStatus(event.currentTarget.error?.message || 'error'); recover(event.currentTarget); }} />
        <NativeAudioRecoveryDialog />
        <SignalPath />
        <div data-testid="status">{status}</div><motion.div data-testid="clock">{label}</motion.div>
        <div className="flex gap-4">
            <button onClick={() => void audio.current?.play().catch(() => {})}>Play</button>
            <button onClick={() => audio.current?.pause()}>Pause</button>
            <button onClick={() => { if (audio.current) audio.current.currentTime = 5; }}>Seek 5s</button>
            <button onClick={() => { setStatus('waiting'); setSource(URL.createObjectURL(silentLocalFile())); }}>Next file</button>
        </div>
    </div>;
}
export default { id: 'nativeAudio', title: 'Windows native audio',
    description: 'Device selection and native deck lifecycle with an injected bridge.', Component: NativeAudioProbe } satisfies ProbeDefinition;
