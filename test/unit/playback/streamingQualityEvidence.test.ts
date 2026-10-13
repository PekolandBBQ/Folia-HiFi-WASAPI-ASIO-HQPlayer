import { describe, expect, it } from 'vitest';
import { assertEncodedQuality, assertNativeSourceFacts, qualityOutcome, findQualityReferenceIndex } from '../../manual/streamingQualityEvidence.mjs';
import { assertColdFoliaModuleGraph } from '../../manual/foliaAppTestReadiness.mjs';

// Acceptance probes must reject wrong tiers, generated PCM and duplicate HMR store identities.
const mp3 = { codec: 'MPEG 1 Layer 3', sampleRate: 48000, bitrate: 128000, lossless: false };
const flac = { codec: 'FLAC', sampleRate: 48000, bitsPerSample: 24, lossless: true };
const legacyResourcePage = (entries: string[]) => {
    let reads = 0;
    return { evaluate: async () => reads++ === 0 ? null : entries };
};
describe('actual streaming quality acceptance evidence', () => {
    it('selects a fixed QQ numeric song id without confusing its distinct provider media id or another platform', () => {
        const songs = [
            { id: 1531817, sourceRef: { providerId: 'netease', mediaId: '1531817' } },
            { id: 54321, sourceRef: { providerId: 'qq', mediaId: 'cover-mid' } },
            { id: 1531817, sourceRef: { providerId: 'qq', mediaId: 'original-mid' } },
        ];
        expect(findQualityReferenceIndex(songs, 'qq', '1531817')).toBe(2);
        expect(findQualityReferenceIndex(songs, 'qq', 'original-mid')).toBe(2);
        expect(findQualityReferenceIndex(songs, 'netease', '1531817')).toBe(0);
        expect(findQualityReferenceIndex(songs, 'qq', 'absent-mid')).toBe(-1);
    });
    it('distinguishes normal provider fallback from an unrelated higher-tier source', () => {
        expect(qualityOutcome('hires', 'lossless')).toBe('provider-fallback');
        expect(qualityOutcome('high', 'high')).toBe('requested-tier');
        expect(() => qualityOutcome('standard', 'high')).toThrow('exceeds');
        expect(() => qualityOutcome('hires', undefined)).toThrow('unknown');
    });
    it('checks compressed tier bitrate in the actual loaded browser prefix', () => {
        expect(assertEncodedQuality('qq', 'standard', { quality: 'standard', requestedQuality: 'standard' }, mp3)).toBe('requested-tier');
        expect(() => assertEncodedQuality('netease', 'high', { quality: 'high', requestedQuality: 'high' }, mp3)).toThrow('bitrate');
        expect(assertEncodedQuality('netease', 'high', { quality: 'high', requestedQuality: 'high' }, { ...mp3, bitrate: 320000 })).toBe('requested-tier');
    });
    it('accepts verified HiRes and normal 16-bit fallback with separate requested tiers', () => {
        expect(assertEncodedQuality('netease', 'hires', { quality: 'hires', requestedQuality: 'hires' }, flac)).toBe('requested-tier');
        expect(assertEncodedQuality('netease', 'hires', { quality: 'lossless', requestedQuality: 'hires' }, { ...flac, bitsPerSample: 16 })).toBe('provider-fallback');
        expect(() => assertEncodedQuality('netease', 'hires', { quality: 'hires', requestedQuality: 'hires' }, { ...flac, bitsPerSample: 16 })).toThrow('HiRes');
    });
    it('does not accept preparation format or a request-only label as original encoding', () => {
        expect(() => assertEncodedQuality('spotify', 'high', { requestedQuality: 'high' }, mp3)).toThrow('unknown');
        expect(() => assertEncodedQuality('spotify', 'lossless', { quality: 'lossless', requestedQuality: 'lossless', preparedAudio: { representation: 'float32' } }, flac)).toThrow('Prepared PCM');
        expect(() => assertEncodedQuality('qq', 'lossless', { quality: 'lossless', requestedQuality: 'lossless' }, mp3)).toThrow('original lossless');
    });
    it('cross-checks native original format against the exact browser source evidence', () => {
        const evidence = { metadata: { quality: 'standard' }, header: mp3 };
        const facts = { session: 'current-session', backend: 'asio', sourceEncodingVerified: true,
            requestedQuality: 'standard', sourceQuality: 'standard', sourceSampleRate: 48000,
            sourceCodec: 'MP3', sourceBitrate: 128000 };
        expect(() => assertNativeSourceFacts(facts, evidence, 'asio', 'standard')).not.toThrow();
        expect(() => assertNativeSourceFacts({ ...facts, backend: 'hqplayer' }, evidence, 'asio', 'standard')).toThrow('current');
        expect(() => assertNativeSourceFacts({ ...facts, sourceBitrate: 320000 }, evidence, 'asio', 'standard')).toThrow('bitrate');
        expect(() => assertNativeSourceFacts({ ...facts, sourceCodec: 'WAV' }, evidence, 'asio', 'standard')).toThrow('codec');
    });
    it('requires native bit depth to agree with the original HiRes header', () => {
        const facts = { session: 'current-session', backend: 'hqplayer', sourceEncodingVerified: true,
            requestedQuality: 'hires', sourceQuality: 'hires', sourceCodec: 'FLAC', sourceSampleRate: 48000, sourceBitsPerSample: 16 };
        expect(() => assertNativeSourceFacts(facts, { metadata: { quality: 'hires' }, header: flac }, 'hqplayer', 'hires')).toThrow('bit depth');
    });
    it('fails before test imports can create a second store after an HMR update', async () => {
        await expect(assertColdFoliaModuleGraph(legacyResourcePage(['/src/stores/useSearchNavigationStore.ts?t=123']))).rejects.toThrow('restart the Vite server');
        await expect(assertColdFoliaModuleGraph(legacyResourcePage([]))).resolves.toEqual({ coldModuleGraph: true });
    });
    it('permits timestamped CSS refresh without treating styles as another store identity', async () => {
        await expect(assertColdFoliaModuleGraph(legacyResourcePage([
            '/src/index.css?t=1791036704165', '/src/components/audio/signalPath.css?direct&t=1791036704165',
        ]))).resolves.toEqual({ coldModuleGraph: true });
    });
    it('still rejects mixed CSS and actual JS or TS script variants', async () => {
        for (const extension of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']) {
            await expect(assertColdFoliaModuleGraph(legacyResourcePage([
                '/src/index.css?t=1791036704165', `/src/services/identity.${extension}?import&t=1791036704165`,
            ]))).rejects.toThrow(`identity.${extension}`);
        }
    });
});
