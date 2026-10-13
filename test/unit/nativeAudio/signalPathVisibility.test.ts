import { beforeEach, expect, it, vi } from 'vitest';
import { useNativeSignalPathEnabled } from '@/hooks/useNativeSignalPathEnabled';

// Browser disclosure requires this song's explicit PCM transport, never a stale native snapshot.
const fixture = vi.hoisted(() => ({
    settings: { nativeAudioBackend: 'browser', showAudioSignalPath: true },
    playback: { currentSong: { id: 'spotify-track', providerId: 'spotify' } as any, audioSrc: 'http://127.0.0.1/current' as string | null },
    metadata: { playbackTransport: 'soloist-pcm' } as any,
    supported: false,
}));
vi.mock('@/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: (select: any) => select(fixture.settings) }));
vi.mock('@/stores/usePlaybackStore', () => ({ usePlaybackStore: (select: any) => select(fixture.playback) }));
vi.mock('@/services/onlineMusic/audioSourceQuality', () => ({ getAudioSourceMetadata: vi.fn(() => fixture.metadata) }));
vi.mock('@/services/nativeAudio/capabilities', () => ({ isNativeAudioSupported: () => fixture.supported }));
beforeEach(() => {
    fixture.settings = { nativeAudioBackend: 'browser', showAudioSignalPath: true };
    fixture.playback = { currentSong: { id: 'spotify-track', providerId: 'spotify' }, audioSrc: 'http://127.0.0.1/current' };
    fixture.metadata = { playbackTransport: 'soloist-pcm' }; fixture.supported = false;
});
it('shows Spotify browser PCM without requiring an independent native output component', () => {
    expect(useNativeSignalPathEnabled()).toBe(true);
    fixture.settings.showAudioSignalPath = false;
    expect(useNativeSignalPathEnabled()).toBe(false);
});
it('keeps ordinary browser and external stage playback hidden without telemetry', () => {
    fixture.metadata = undefined;
    expect(useNativeSignalPathEnabled()).toBe(false);
    fixture.metadata = { preparedAudio: { representation: 's32le' } };
    expect(useNativeSignalPathEnabled()).toBe(false);
    fixture.metadata = { playbackTransport: 'soloist-pcm' };
    fixture.playback.currentSong.isStage = true;
    expect(useNativeSignalPathEnabled()).toBe(false);
    fixture.playback.currentSong.isStage = false; fixture.playback.audioSrc = null;
    expect(useNativeSignalPathEnabled()).toBe(false);
});
it('retains native support checks and the HQPlayer controls available without a loaded source', () => {
    fixture.settings.nativeAudioBackend = 'asio';
    expect(useNativeSignalPathEnabled()).toBe(false);
    fixture.supported = true;
    expect(useNativeSignalPathEnabled()).toBe(true);
    fixture.settings.nativeAudioBackend = 'hqplayer'; fixture.settings.showAudioSignalPath = false;
    fixture.playback.currentSong = null; fixture.playback.audioSrc = null;
    expect(useNativeSignalPathEnabled()).toBe(true);
});
