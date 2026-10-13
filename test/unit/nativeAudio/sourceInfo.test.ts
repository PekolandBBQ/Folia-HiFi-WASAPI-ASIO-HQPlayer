import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Prepared containers cannot supply facts about an unknown original encoding.
const { normalizeSourceMetadata, readOriginalSourceInfo, readSourceInfo } = createRequire(import.meta.url)('../../../electron/nativeAudio/sourceInfo.cjs');
it('reads exact FLAC STREAMINFO while omitting an average bitrate from an incomplete file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-source-info-'));
    try {
        const header = Buffer.alloc(42); header.write('fLaC'); header[4] = 0x80; header.writeUIntBE(34, 5, 3);
        header.writeUInt16BE(4096, 8); header.writeUInt16BE(4096, 10);
        header.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (23n << 36n) | (48000n * 120n), 18);
        const file = path.join(directory, 'partial.flac'); await writeFile(file, header);
        expect(await readSourceInfo(file, { complete: false })).toMatchObject({
            sourceCodec: 'FLAC', sourceSampleRate: 48000, sourceBitsPerSample: 24, sourceBitrate: undefined,
        });
    } finally { await rm(directory, { force: true, recursive: true }); }
});
it('keeps generated PCM32 out of original source telemetry and keeps the requested tier unverified', async () => {
    const read = vi.fn(async () => ({ sourceCodec: 'PCM', sourceBitsPerSample: 32, sourceSampleRate: 44100 }));
    const state = await readOriginalSourceInfo({ input: 'generated.wav', sourceMetadata: normalizeSourceMetadata({
        requestedQuality: 'high', preparedAudio: { representation: 'float32', sampleRate: 44100, channels: 2 },
    }) }, read);
    expect(read).not.toHaveBeenCalled();
    expect({ sourceBitsPerSample: 32, sourceSampleRate: 44100, ...state }).toMatchObject({
        requestedQuality: 'high', sourceQuality: undefined, sourceCodec: undefined,
        sourceBitsPerSample: undefined, sourceSampleRate: undefined, preparedSource: true, sourceEncodingVerified: false,
        preparedAudio: { representation: 'float32', sampleRate: 44100, channels: 2 },
    });
});
it('carries received PCM separately without promoting it to original or output format', async () => {
    const preparedAudio = { representation: 's32le', sampleRate: 44100, channels: 2, bitDepth: 32 };
    const metadata = normalizeSourceMetadata({ requestedQuality: 'lossless', preparedAudio });
    const state = await readOriginalSourceInfo({ sourceMetadata: metadata }, vi.fn());
    expect(state.preparedAudio).toEqual(preparedAudio);
    expect(state.preparedAudio).not.toBe(metadata.preparedAudio);
    expect(state.sourceQuality).toBeUndefined();
    expect(state.sourceEncodingVerified).toBe(false);
    expect(state.sourceBitsPerSample).toBeUndefined();
    expect(state.outputFormat).toBeUndefined();
    expect(state.sampleRate).toBeUndefined();
});
it('keeps provider fallback distinct from verified FLAC headers', async () => {
    const state = await readOriginalSourceInfo({ input: 'original.flac', sourceMetadata: normalizeSourceMetadata({
        requestedQuality: 'hires', quality: 'lossless', providerLevel: 'lossless', sourceFormat: { codec: 'FLAC' },
    }) }, async () => ({ sourceCodec: 'FLAC', sourceBitsPerSample: 16, sourceSampleRate: 48000 }));
    expect(state).toMatchObject({ requestedQuality: 'hires', sourceQuality: 'lossless', sourceProviderLevel: 'lossless',
        sourceCodec: 'FLAC', sourceBitsPerSample: 16, sourceSampleRate: 48000, preparedSource: false, sourceEncodingVerified: true });
});
it('retains verified encoded passthrough facts even when the downloaded header is not complete', async () => {
    const state = await readOriginalSourceInfo({ input: 'growing.ogg', sourceMetadata: normalizeSourceMetadata({
        requestedQuality: 'standard', quality: 'standard', sourceFormat: { codec: 'Vorbis', bitrate: 160000, sampleRate: 44100 },
    }) }, async () => ({}));
    expect(state).toMatchObject({ sourceCodec: 'Vorbis', sourceBitrate: 160000, sourceQuality: 'standard' });
});
it('rejects malformed or unbounded metadata before replacing a playback session', () => {
    for (const value of [{ quality: 'pretend-lossless' }, { sourceFormat: { codec: 'x'.repeat(65) } },
        { preparedAudio: { representation: 'float32', channels: 200 } }, { sourceFormat: { bitrate: Infinity } }]) {
        expect(() => normalizeSourceMetadata(value)).toThrow();
    }
});
