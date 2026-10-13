import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { getAudioSourceMetadata, getAudioSourceQuality, rememberAudioSourceQuality } from '@/services/onlineMusic/audioSourceQuality';

// Source quality is provider evidence, not a copy of the user's requested setting or another account's source.
const song = (provider: string) => ({ id: 'quality-map-test', name: 'Song', artists: [], durationMs: 1000,
    album: { id: 1, name: 'Album' }, sourceRef: { kind: 'online', providerId: provider, mediaId: 'quality-map-test' } }) as SongResult;

describe('actual audio source quality map', () => {
    it('keeps transport selection bound to the exact provider, song and source URL', () => {
        const target = song('spotify'), url = 'http://127.0.0.1/opaque';
        rememberAudioSourceQuality(target, { url, fetchedAt: 0, playbackTransport: 'soloist-pcm' });
        expect(getAudioSourceMetadata(target, url)?.playbackTransport).toBe('soloist-pcm');
        expect(getAudioSourceMetadata(target, url + '-other')).toBeUndefined();
        expect(getAudioSourceMetadata(song('qq'), url)).toBeUndefined();
        rememberAudioSourceQuality(target, { url, fetchedAt: 1, preparedAudio: { representation: 's32le' } });
        expect(getAudioSourceMetadata(target, url)?.playbackTransport).toBeUndefined();
    });
    it('remembers the returned lower tier independently of the requested tier', () => {
        const target = song('netease'); const url = 'https://music.test/fallback';
        rememberAudioSourceQuality(target, { url, fetchedAt: 0, requestedQuality: 'hires', quality: 'lossless' });
        expect(getAudioSourceQuality(target, url)).toBe('lossless');
    });

    it('removes stale quality evidence when the same concrete source is subsequently unknown', () => {
        const target = song('netease'); const url = 'https://music.test/unknown';
        rememberAudioSourceQuality(target, { url, fetchedAt: 0, quality: 'high' });
        rememberAudioSourceQuality(target, { url, fetchedAt: 1, requestedQuality: 'hires' });
        expect(getAudioSourceQuality(target, url)).toBeUndefined();
        expect(getAudioSourceMetadata(target, url)).toEqual({ requestedQuality: 'hires' });
    });

    it('isolates equal URLs and IDs across providers and keeps distinct encodings independent', () => {
        const url = 'https://music.test/shared';
        rememberAudioSourceQuality(song('netease'), { url, fetchedAt: 0, quality: 'standard' });
        rememberAudioSourceQuality(song('qq'), { url, fetchedAt: 0, quality: 'lossless' });
        rememberAudioSourceQuality(song('netease'), { url: `${url}/other`, fetchedAt: 0, quality: 'high' });
        expect(getAudioSourceQuality(song('netease'), url)).toBe('standard');
        expect(getAudioSourceQuality(song('qq'), url)).toBe('lossless');
        expect(getAudioSourceQuality(song('netease'), `${url}/other`)).toBe('high');
    });
    it('snapshots original and prepared metadata independently of mutable provider objects', () => {
        const url = 'https://music.test/metadata', target = song('spotify');
        const sourceFormat = { codec: 'vorbis', sampleRate: 44100, bitrate: 160000 };
        const preparedAudio = { representation: 'float32', sampleRate: 44100, bitDepth: 32 };
        rememberAudioSourceQuality(target, { url, fetchedAt: 0, requestedQuality: 'high', sourceFormat, preparedAudio });
        sourceFormat.bitrate = 320000; preparedAudio.bitDepth = 24;
        expect(getAudioSourceMetadata(target, url)).toEqual({ requestedQuality: 'high',
            sourceFormat: { codec: 'vorbis', sampleRate: 44100, bitrate: 160000 },
            preparedAudio: { representation: 'float32', sampleRate: 44100, bitDepth: 32 } });
    });
});
