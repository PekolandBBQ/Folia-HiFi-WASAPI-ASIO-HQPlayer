import HQPlayerDspEditor from '../../src/components/audio/HQPlayerDspEditor';
import NowPlayingToast from '../../src/components/app/overlays/NowPlayingToast';
import HQPlayerConnectionDialog from '../../src/components/audio/HQPlayerConnectionDialog';
import HQPlayerLaunchSetting from '../../src/components/audio/HQPlayerLaunchSetting';
import { withHQPlayer } from '../../src/services/nativeAudio/hqplayerSettings';
import { useEffect, type CSSProperties } from 'react';
import type { ProbeDefinition } from './definition';
import PlaybackLoadProgress from '../../src/components/audio/PlaybackLoadProgress';
import DecodeCompatibilitySetting from '../../src/components/audio/DecodeCompatibilitySetting';
import SignalPath from '../../src/components/audio/SignalPath';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { publishSignalPath } from '../../src/stores/useSignalPathStore';
import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad } from '../../src/stores/usePlaybackLoadStore';
import { requestDecodeCompatibility } from '../../src/stores/useDecodeCompatibilityStore';
import { useThemeSettingsStore } from '../../src/stores/useThemeSettingsStore';

// Real controls, staged DSP actions and request-owned loading/compatibility states for UI review.
function PlaybackPreparationProbe({ daylight = false }: { daylight?: boolean } = {}) {
    useEffect(() => {
        useAudioSettingsStore.setState({ nativeAudioBackend: 'hqplayer', showAudioSignalPath: true });
        usePlaybackStore.setState({ audioSrc: 'blob:probe', currentSong: { id: 'probe', name: 'Silent test', artists: [], album: { id: 'probe', name: '' }, durationMs: 10000 } });
        publishSignalPath({ session: 'probe-session', backend: 'hqplayer', deviceId: 'hqplayer-local', position: 0, duration: 10, playing: false, ended: false, sampleRate: 44100, channels: 2, latency: 0 });
    }, []);
    useEffect(() => { useThemeSettingsStore.setState({ isDaylight: daylight }); }, [daylight]);
    return <div className={`min-h-screen ${daylight ? 'bg-zinc-200' : 'bg-zinc-900'}`}><div className="p-8 max-w-xl" style={{ color: 'var(--text-primary)', '--text-primary': daylight ? '#1c1917' : '#f4f4f5', '--text-secondary': daylight ? '#44403c' : '#d4d4d8' } as CSSProperties}>
        <DecodeCompatibilitySetting /><HQPlayerLaunchSetting /><HQPlayerConnectionDialog />
        <button onClick={() => void withHQPlayer(() => {})}>Connect existing</button>
        <button onClick={() => usePlaybackStore.setState({ currentSong: null, audioSrc: '' })}>Clear song</button>
        <button onClick={() => publishSignalPath({ session: 'probe-session-two', backend: 'hqplayer', deviceId: 'hqplayer-local', position: 0, duration: 10, playing: false, ended: false, sampleRate: 48000, channels: 2, latency: 0 })}>New session</button>
        <button onClick={() => { beginPlaybackLoad('probe', 'download'); updatePlaybackLoad('probe', { stage: 'download', loaded: 1048576, total: 4194304 }); }}>Download</button>
        <button className="ml-4" onClick={() => { beginPlaybackLoad('probe', 'decode'); }}>Decode</button>
        <button className="ml-4" onClick={() => { beginPlaybackLoad('probe', 'buffer'); updatePlaybackLoad('probe', { stage: 'buffer', loaded: 200, total: 350, unit: 'milliseconds' }); }}>Buffer</button>
        <button className="ml-4" onClick={() => updatePlaybackLoad('probe', { stage: 'download', loaded: 2097152, total: 4194304 })}>Resume download</button>
        <button className="ml-4" onClick={() => endPlaybackLoad('probe')}>Finish</button>
        <button className="ml-4" onClick={() => void requestDecodeCompatibility('probe', new AbortController().signal)}>Strict error</button>
        <HQPlayerDspEditor defaults /><PlaybackLoadProgress /><SignalPath />
        <NowPlayingToast song={{ title: '正在切换的歌曲', artist: '测试歌手', coverUrl: null }} trackKey="probe-toast" isDaylight={daylight} mode="always" />
    </div></div>;
}
export default { id: 'playbackPreparation', title: 'Playback preparation', description: 'Loading telemetry and explicit compatibility/DSP choices', Component: PlaybackPreparationProbe } satisfies ProbeDefinition;
