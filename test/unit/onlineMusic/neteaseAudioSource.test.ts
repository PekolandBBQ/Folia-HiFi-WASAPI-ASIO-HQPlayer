import { describe, expect, it } from 'vitest';
import { normalizeNeteaseAudioSource } from '@/services/onlineMusic/neteaseAudioSource';

// Verify source metadata describes the actual returned encoding instead of the requested setting.
describe('NetEase actual audio source metadata', () => {
    it('preserves the live-observed hires to lossless fallback and disregards conflicting encodeType', () => {
        const source = normalizeNeteaseAudioSource({ url: 'http://music.test/track', level: 'lossless',
            type: 'flac', encodeType: 'mp3', br: 1_050_838, sr: 44100 }, 'hires');
        expect(source).toMatchObject({ url: 'https://music.test/track', requestedQuality: 'hires',
            quality: 'lossless', providerLevel: 'lossless', sourceFormat: { codec: 'flac', bitrate: 1_050_838, sampleRate: 44100 } });
        expect(source?.sourceFormat?.bitsPerSample).toBeUndefined();
    });

    it.each([['standard', 'standard'], ['higher', 'high'], ['exhigh', 'high'], ['lossless', 'lossless'], ['hires', 'hires']])(
        'maps returned level %s to actual tier %s', (level, quality) => {
            expect(normalizeNeteaseAudioSource({ url: 'https://music.test/track', level }, 'hires')?.quality).toBe(quality);
        });

    it('retains an unknown provider level without inventing a tier from bitrate or filename', () => {
        const source = normalizeNeteaseAudioSource({ url: 'https://music.test/track.flac', level: 'jymaster', br: 320000,
            encodeType: 'flac' }, 'hires');
        expect(source?.quality).toBeUndefined();
        expect(source).toMatchObject({ requestedQuality: 'hires', providerLevel: 'jymaster', sourceFormat: { bitrate: 320000 } });
        expect(source?.sourceFormat?.codec).toBeUndefined();
        expect(normalizeNeteaseAudioSource({ url: 'https://music.test/track', level: 'constructor' }, 'hires')?.quality).toBeUndefined();
    });

    it('leaves missing metadata unknown and retains only explicit valid numeric fields', () => {
        const source = normalizeNeteaseAudioSource({ url: 'https://music.test/track', sr: '96000', bitDepth: '24', br: 0 }, 'lossless');
        expect(source?.quality).toBeUndefined();
        expect(source?.providerLevel).toBeUndefined();
        expect(source?.sourceFormat).toEqual({ sampleRate: 96000, bitsPerSample: 24 });
        expect(normalizeNeteaseAudioSource({ url: 'https://music.test/track', type: 'm4a', sr: -1,
            bitsPerSample: NaN, br: Infinity }, 'high')?.sourceFormat).toBeUndefined();
    });

    it('does not produce a source when the provider returns no stream URL', () => {
        expect(normalizeNeteaseAudioSource({ level: 'hires', type: 'flac' }, 'hires')).toBeNull();
        expect(normalizeNeteaseAudioSource(null, 'standard')).toBeNull();
    });
});
