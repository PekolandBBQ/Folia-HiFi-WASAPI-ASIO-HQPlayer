import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/hqplayerSource.test.ts — extension recovery for staged URLs and cached blobs.
const { prepareHQPlayerSource, resolveAudioExtension, sniffAudioExtension, UNKNOWN_SOURCE_CODE }
    = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerSource.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function source(header: number[] | string) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'folia-hq-source-test-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'input.audio');
    await writeFile(file, typeof header === 'string' ? Buffer.from(header, 'ascii') : Buffer.from(header));
    return file;
}

describe('HQPlayer staged source naming', () => {
    it('prefers a real filename and falls back to URL or MIME type', () => {
        expect(resolveAudioExtension({ sourceName: 'original.FLAC', mimeType: 'audio/mpeg' })).toBe('.flac');
        expect(resolveAudioExtension({ url: 'https://cdn.example/file.m4a?token=one' })).toBe('.m4a');
        expect(resolveAudioExtension({ url: 'https://cdn.example/play?id=one', mimeType: 'audio/flac; charset=binary' })).toBe('.flac');
    });
    it('does not invent a format from an unknown content type', () => {
        expect(resolveAudioExtension({ url: 'https://cdn.example/play', mimeType: 'application/octet-stream' })).toBe('');
    });
    it.each([
        ['FLAC', 'fLaC', '.flac'],
        ['WAVE', 'RIFF\0\0\0\0WAVE', '.wav'],
        ['AIFF', 'FORM\0\0\0\0AIFF', '.aiff'],
        ['Opus', 'OggS\0\0\0\0OpusHead', '.opus'],
        ['MP3', 'ID3\x04\0\0', '.mp3'],
        ['CAF', 'caff\0\x01\0\0', '.caf'],
        ['WavPack', 'wvpk', '.wv'],
        ['DSF', 'DSD ', '.dsf'],
        ['DFF', 'FRM8\0\0\0\0DSD ', '.dff'],
    ])('recognizes an extensionless %s file by its header', async (_label, header, extension) => {
        expect(await sniffAudioExtension(await source(header))).toBe(extension);
    });
    it('recognizes an MP4 audio container from its ftyp box', async () => {
        expect(await sniffAudioExtension(await source([0, 0, 0, 24, ...Buffer.from('ftypM4A ')]))).toBe('.m4a');
    });
    it('renames an extensionless cached source before HQPlayer sees it', async () => {
        const prepared = await prepareHQPlayerSource(await source('fLaC'), {});
        expect(prepared).toMatch(/input\.flac$/);
    });
    it('marks a source with no usable metadata or file signature for compatible decoding', async () => {
        await expect(prepareHQPlayerSource(await source('unknown'), {})).rejects.toMatchObject({ code: UNKNOWN_SOURCE_CODE });
    });
});
