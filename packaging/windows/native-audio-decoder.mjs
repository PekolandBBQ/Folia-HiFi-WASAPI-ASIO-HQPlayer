import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';

// packaging/windows/native-audio-decoder.mjs — the upstream audio-only build lacks PCM24 encoding.
// Keep this decoder separate from the existing transcode and mod-export runtime slots.
export const DECODER_URL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip';
export const DECODER_SHA256 = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareNativeDecoder(directory) {
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, 'ffmpeg.exe');
    const marker = path.join(directory, 'decoder-bundle.json');
    try {
        const record = JSON.parse(await readFile(marker, 'utf8'));
        if (record.archiveSha256 === DECODER_SHA256 && record.binarySha256 === digest(await readFile(binary))) return;
    } catch { /* First build or an interrupted download. */ }
    const response = await fetch(DECODER_URL);
    if (!response.ok) throw new Error(`Native decoder download failed: ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    if (digest(archive) !== DECODER_SHA256) throw new Error('Native decoder archive checksum mismatch');
    const files = unzipSync(archive, { filter: file => /\/(bin\/ffmpeg\.exe|LICENSE|LICENSE\.txt|README\.txt)$/i.test(file.name) });
    const entry = Object.entries(files).find(([name]) => name.endsWith('/bin/ffmpeg.exe'));
    if (!entry) throw new Error('Native decoder archive has no ffmpeg.exe');
    await writeFile(binary, entry[1]);
    for (const [name, bytes] of Object.entries(files)) {
        if (name === entry[0]) continue;
        await writeFile(path.join(directory, `FFmpeg-${path.basename(name)}.txt`), bytes);
    }
    await writeFile(path.join(directory, 'FFmpeg-SOURCE.txt'),
        `FFmpeg 8.1.2 essentials, Gyan Doshi, GPLv3.\nBinary: ${DECODER_URL}\nArchive SHA-256: ${DECODER_SHA256}\n`
        + 'Build information and corresponding source links: https://www.gyan.dev/ffmpeg/builds/\n'
        + 'FFmpeg source: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz\n');
    await writeFile(marker, JSON.stringify({ archiveSha256: DECODER_SHA256, binarySha256: digest(entry[1]) }, null, 2));
}
