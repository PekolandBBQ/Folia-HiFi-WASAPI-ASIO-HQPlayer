import { afterEach, expect, it, vi } from 'vitest';
import { NativeAudioTransport } from '../../../src/services/nativeAudio/NativeAudioTransport';
import type { NativeAudioApi, NativeAudioState } from '../../../src/types/nativeAudio';
import { usePlaybackLoadStore } from '../../../src/stores/usePlaybackLoadStore';

// test/unit/nativeAudio/streamingGainAcknowledgment.test.ts: the owning native transport waits for each gain acknowledgement before play.
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/services/nativeAudio/loadOnlineSource', () => ({ loadNativeOnlineSource: mocks.load }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  usePlaybackLoadStore.setState({ owner: '', startedAt: 0, progress: null });
  vi.restoreAllMocks(); vi.clearAllMocks();
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(backend: 'wasapi-exclusive' | 'asio') {
  let state: NativeAudioState = { session: '', position: 0, duration: 120, playing: false, ended: false,
    streaming: true, buffering: false, bufferedStart: 0, bufferedEnd: 0.5, producerComplete: false,
    sampleRate: 44100, channels: 2, latency: 0.02, backend, deviceId: 'synthetic-output' };
  const volume = deferred(), replaygain = deferred();
  const request = vi.fn(async ({ action, session }: Parameters<NativeAudioApi['request']>[0]) => {
    if (action === 'stop') return {};
    if (session !== state.session) throw new Error('Stale synthetic native session');
    if (action === 'volume') await volume.promise;
    if (action === 'replaygain') await replaygain.promise;
    if (action === 'play') state = { ...state, playing: true };
    return { ...state };
  });
  const api: NativeAudioApi = { supported: true, request, onEvent: () => () => {} };
  mocks.load.mockImplementation(async (_api, session) => { state = { ...state, session }; return { ...state }; });
  const transport = new NativeAudioTransport(api, backend, state.deviceId, 'integer-direct', async () => null);
  transport.volume = 0.01; transport.setReplayGain(1);
  cleanups.push(() => { volume.resolve(); replaygain.resolve(); transport.dispose(); });
  return { transport, request, volume, replaygain, actions: () => request.mock.calls.map(([args]) => args.action) };
}
it.each(['wasapi-exclusive', 'asio'] as const)('waits for independent 1%% volume and ReplayGain OFF acknowledgements before %s play', async backend => {
  const f = fixture(backend); f.transport.setSource('http://127.0.0.1:1234/synthetic-live-pcm');
  const playing = f.transport.play(); void playing.catch(() => {});
  await vi.waitFor(() => expect(f.actions()).toContain('volume'));
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'volume', volume: 0.01 }));
  expect(f.actions()).not.toContain('replaygain'); expect(f.actions()).not.toContain('play');
  f.volume.resolve(); await vi.waitFor(() => expect(f.actions()).toContain('replaygain'));
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'replaygain', gain: 1 }));
  expect(f.actions()).not.toContain('play');
  f.replaygain.resolve(); await playing;
  expect(f.actions().slice(-3)).toEqual(['volume', 'replaygain', 'play']); expect(f.transport.paused).toBe(false);
});
it('cancels playback intent during a pending gain acknowledgment before native play', async () => {
  const f = fixture('wasapi-exclusive'); f.transport.setSource('http://127.0.0.1:1234/synthetic-live-pcm');
  const playing = f.transport.play().then(() => null, error => error);
  await vi.waitFor(() => expect(f.actions()).toContain('volume'));
  f.transport.pause(); f.volume.resolve(); f.replaygain.resolve();
  expect((await playing).name).toBe('AbortError'); expect(f.actions()).not.toContain('play'); expect(f.transport.paused).toBe(true);
});
