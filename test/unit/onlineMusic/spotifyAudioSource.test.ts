import { describe, expect, it } from 'vitest';
import { normalizeSpotifyAudioSource } from '@/services/onlineMusic/spotifyAudioSource';

// test/unit/onlineMusic/spotifyAudioSource.test.ts: original quality facts and explicit transport identity.
it('retains only the explicit Soloist transport marker; legacy generated PCM does not imply it', () => {
    const pcm = { url: 'http://127.0.0.1/source', preparedAudio: { representation: 's32le' } };
    expect(normalizeSpotifyAudioSource(pcm, 'high')?.playbackTransport).toBeUndefined();
    expect(normalizeSpotifyAudioSource({ ...pcm, playbackTransport: 'unknown' }, 'high')?.playbackTransport).toBeUndefined();
    expect(normalizeSpotifyAudioSource({ ...pcm, playbackTransport: 'soloist-pcm' }, 'high')?.playbackTransport).toBe('soloist-pcm');
});

// Original compressed-source evidence and a generated float32 transport must never share a format label.
describe('Spotify shared audio source metadata', () => {
    it('maps verified original facts and lower returned quality separately from the request', () => {
        const source = normalizeSpotifyAudioSource({ url: 'http://127.0.0.1/source', fetchedAt: 123, quality: 'standard',
            actualQuality: 'standard', streaming: true, sourceInfo: { encodingVerified: true, codec: 'vorbis',
                sampleRate: 44100, bitDepth: null, bitrate: 160000 } }, 'high');
        expect(source).toEqual({ url: 'http://127.0.0.1/source', fetchedAt: 123, streaming: true,
            quality: 'standard', requestedQuality: 'high', sourceFormat: { codec: 'vorbis', sampleRate: 44100, bitrate: 160000 } });
    });
    it('keeps a verified 192k stream tier unknown instead of relabelling it as the high request', () => {
        const source = normalizeSpotifyAudioSource({ url: 'http://127.0.0.1/source', actualQuality: null, quality: 'high',
            sourceInfo: { encodingVerified: true, codec: 'vorbis', sampleRate: 44100, bitrate: 192000 } }, 'high');
        expect(source?.quality).toBeUndefined(); expect(source?.requestedQuality).toBe('high');
        expect(source?.sourceFormat?.bitrate).toBe(192000);
    });
    it('retains generated PCM facts without inventing original source quality or resolution', () => {
        const source = normalizeSpotifyAudioSource({ url: 'http://127.0.0.1/source', actualQuality: null, quality: 'high',
            sourceInfo: { encodingVerified: false, codec: 'WAV', sampleRate: 44100, bitDepth: 32 },
            preparedAudio: { representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 } }, 'high');
        expect(source?.quality).toBeUndefined(); expect(source?.sourceFormat).toBeUndefined();
        expect(source?.preparedAudio).toEqual({ representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 });
    });
    it('does not treat a legacy requested-only result as original format evidence', () => {
        const source = normalizeSpotifyAudioSource({ url: 'http://127.0.0.1/source', quality: 'high' }, 'high');
        expect(source?.quality).toBeUndefined(); expect(source?.sourceFormat).toBeUndefined();
        expect(normalizeSpotifyAudioSource(null, 'high')).toBeNull();
    });
});

it('accepts the cable transport without claiming source encoding or lossless quality', () => {
    const value = normalizeSpotifyAudioSource({ url: 'http://127.0.0.1/opaque', playbackTransport: 'cable-pcm', actualQuality: 'lossless',
        sourceInfo: { encodingVerified: true, codec: 'FLAC', sampleRate: 44100 },
        preparedAudio: { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 } }, 'lossless');
    expect(value).toMatchObject({ playbackTransport: 'cable-pcm', preparedAudio: { sampleRate: 44100 } });
    expect(value?.quality).toBeUndefined(); expect(value?.sourceFormat).toBeUndefined();
});
