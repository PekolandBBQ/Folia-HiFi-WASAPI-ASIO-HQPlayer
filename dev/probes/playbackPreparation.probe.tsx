import HQPlayerDspEditor from '../../src/components/audio/HQPlayerDspEditor';
import NowPlayingToast from '../../src/components/app/overlays/NowPlayingToast';
import HQPlayerConnectionDialog from '../../src/components/audio/HQPlayerConnectionDialog';
import HQPlayerLaunchSetting from '../../src/components/audio/HQPlayerLaunchSetting';
import { withHQPlayer } from '../../src/services/nativeAudio/hqplayerSettings';
import { useEffect } from 'react';
import type { ProbeDefinition } from './definition';
import PlaybackLoadProgress from '../../src/components/audio/PlaybackLoadProgress';
import DecodeCompatibilitySetting from '../../src/components/audio/DecodeCompatibilitySetting';
import SignalPath from '../../src/components/audio/SignalPath';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { publishSignalPath } from '../../src/stores/useSignalPathStore';
import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad } from '../../src/stores/usePlaybackLoadStore';
import { requestDecodeCompatibility } from '../../src/stores/useDecodeCompatibilityStore';

// Real controls, staged DSP actions and request-owned loading/compatibility states for UI review.
function PlaybackPreparationProbe() {
    useEffect(() => {
        useAudioSettingsStore.setState({ nativeAudioBackend: 'hqplayer', showAudioSignalPath: true });
        usePlaybackStore.setState({ audioSrc: 'blob:probe', currentSong: { id: 'probe', name: 'Silent test', artists: [], album: { id: 'probe', name: '' }, durationMs: 10000 } });
        publishSignalPath({ session: 'probe-session', backend: 'hqplayer', deviceId: 'hqplayer-local', position: 0, duration: 10, playing: false, ended: false, sampleRate: 44100, channels: 2, latency: 0 });
    }, []);
    return <div className="p-8 max-w-xl" style={{ color: 'var(--text-primary)' }}>
        <DecodeCompatibilitySetting /><HQPlayerLaunchSetting /><HQPlayerConnectionDialog />
        <button onClick={() => void withHQPlayer(() => {})}>Connect existing</button>
        <button onClick={() => usePlaybackStore.setState({ currentSong: null, audioSrc: '' })}>Clear song</button>
        <button onClick={() => { beginPlaybackLoad('probe', 'download'); updatePlaybackLoad('probe', { stage: 'download', loaded: 1048576, total: 4194304 }); }}>Download</button>
        <button className="ml-4" onClick={() => { beginPlaybackLoad('probe', 'decode'); }}>Decode</button>
        <button className="ml-4" onClick={() => endPlaybackLoad('probe')}>Finish</button>
        <button className="ml-4" onClick={() => void requestDecodeCompatibility('probe', new AbortController().signal)}>Strict error</button>
        <HQPlayerDspEditor defaults /><PlaybackLoadProgress /><SignalPath />
        <NowPlayingToast song={{ title: '正在切换的歌曲', artist: '测试歌手', coverUrl: null }} trackKey="probe-toast" isDaylight={false} mode="always" />
    </div>;
}
export default { id: 'playbackPreparation', title: 'Playback preparation', description: 'Loading telemetry and explicit compatibility/DSP choices', Component: PlaybackPreparationProbe } satisfies ProbeDefinition;
