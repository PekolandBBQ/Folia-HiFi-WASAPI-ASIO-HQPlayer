// electron/hqplayer/wavHeader.cjs — PCM32 WAVE_FORMAT_EXTENSIBLE; live pipe sentinels never masquerade as a finite file.
const HEADER_BYTES = 68;
function liveDataLimit(channels) { return Math.floor((0xffffffff - (HEADER_BYTES - 8)) / (channels * 4)) * channels * 4; }
function wavHeader(rate, channels, bytes) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 384000 || !Number.isInteger(channels) || channels < 1 || channels > 8
        || (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % (channels * 4) || bytes > liveDataLimit(channels))))
        throw new Error('Invalid PCM WAV layout');
    const header = Buffer.alloc(HEADER_BYTES);
    const mask = [0, 4, 3, 7, 0x33, 0x37, 0x3f, 0x70f, 0x63f][channels];
    header.write('RIFF'); header.writeUInt32LE(bytes === undefined ? 0xffffffff : HEADER_BYTES - 8 + bytes, 4);
    header.write('WAVEfmt ', 8); header.writeUInt32LE(40, 16);
    header.writeUInt16LE(0xfffe, 20); header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28);
    header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
    header.writeUInt16LE(22, 36); header.writeUInt16LE(32, 38); header.writeUInt32LE(mask, 40);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(header, 44);
    header.write('data', 60); header.writeUInt32LE(bytes === undefined ? 0xffffffff : bytes, 64);
    return header;
}
module.exports = { wavHeader, liveDataLimit, HEADER_BYTES };
