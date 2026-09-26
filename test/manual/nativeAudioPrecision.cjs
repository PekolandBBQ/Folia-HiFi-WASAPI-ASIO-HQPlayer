const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { decodeLocalAudio } = require('../../electron/nativeAudio/decode.cjs');

// test/manual/nativeAudioPrecision.cjs — offline PCM24 -> FLAC -> PCM32 sample identity; no sound output.
async function main() {
    const exe = path.resolve(process.env.FOLIA_NATIVE_FFMPEG_PATH || 'build/ffmpeg/win-x64/ffmpeg.exe');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-precision-'));
    try {
        const samples = [-8388608, -4194305, -257, -1, 0, 1, 257, 4194305, 8388607, 0];
        const wave = Buffer.alloc(44 + samples.length * 3);
        wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
        wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
        wave.writeUInt32LE(96000, 24); wave.writeUInt32LE(576000, 28);
        wave.writeUInt16LE(6, 32); wave.writeUInt16LE(24, 34); wave.write('data', 36); wave.writeUInt32LE(samples.length * 3, 40);
        samples.forEach((sample, index) => wave.writeIntLE(sample, 44 + index * 3, 3));
        const input = path.join(directory, 'input.wav'), flac = path.join(directory, 'input.flac');
        await fs.writeFile(input, wave);
        execFileSync(exe, ['-nostdin', '-v', 'error', '-i', input, '-c:a', 'flac', flac], { windowsHide: true });
        const output = await decodeLocalAudio(exe, flac, directory, new AbortController().signal, 'integer-direct');
        const bytes = await fs.readFile(output);
        let offset = 12;
        while (bytes.toString('ascii', offset, offset + 4) !== 'data') {
            offset += 8 + bytes.readUInt32LE(offset + 4) + (bytes.readUInt32LE(offset + 4) % 2);
            assert.ok(offset + 8 <= bytes.length, 'Missing WAV data');
        }
        samples.forEach((sample, index) => assert.equal(bytes.readInt32LE(offset + 8 + index * 4), sample * 256));
        console.log('PASS: 96 kHz PCM24 -> FLAC -> PCM32 preserves all 10 signed boundary samples exactly');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
