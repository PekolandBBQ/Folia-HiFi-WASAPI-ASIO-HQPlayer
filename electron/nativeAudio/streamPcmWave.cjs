// Incremental FFmpeg PCM32 WAV parser; pipe lengths are unknown until producer EOF.
class StreamPcmWave {
    pending = Buffer.alloc(0); riff = false; data = false; format = null;
    feed(chunk) {
        this.pending = Buffer.concat([this.pending, chunk]);
        if (!this.riff) {
            if (this.pending.length < 12) return [];
            if (this.pending.toString('ascii', 0, 4) !== 'RIFF' || this.pending.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected decoded RIFF/WAVE');
            this.pending = this.pending.subarray(12); this.riff = true;
        }
        while (!this.data) {
            if (this.pending.length < 8) return [];
            const type = this.pending.toString('ascii', 0, 4), size = this.pending.readUInt32LE(4);
            if (type === 'data') {
                if (!this.format) throw new Error('Missing decoded PCM format');
                this.data = true; this.pending = this.pending.subarray(8); break;
            }
            if (size > 65536) throw new Error('Excessive decoded WAV header');
            const length = 8 + size + (size & 1);
            if (this.pending.length < length) return [];
            if (type === 'fmt ') {
                if (size < 16) throw new Error('Invalid decoded PCM format');
                const tag = this.pending.readUInt16LE(8), channels = this.pending.readUInt16LE(10);
                const sampleRate = this.pending.readUInt32LE(12), align = this.pending.readUInt16LE(20), bits = this.pending.readUInt16LE(22);
                const integer = tag === 1 || (tag === 65534 && size >= 40 && this.pending.subarray(32, 48).toString('hex') === '0100000000001000800000aa00389b71');
                if (!integer || bits !== 32 || align !== channels * 4 || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 384000) throw new Error('Unsupported decoded PCM format');
                this.format = { sampleRate, channels, blockAlign: align };
            }
            this.pending = this.pending.subarray(length);
        }
        const length = this.pending.length - this.pending.length % this.format.blockAlign;
        const pcm = this.pending.subarray(0, length);
        this.pending = Buffer.from(this.pending.subarray(length));
        return pcm.length ? [pcm] : [];
    }
    finish() { if (!this.data || this.pending.length) throw new Error('Truncated decoded PCM stream'); }
}
module.exports = { StreamPcmWave };
