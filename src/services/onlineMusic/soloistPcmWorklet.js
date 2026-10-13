// src/services/onlineMusic/soloistPcmWorklet.js: one second of stereo PCM, clocked by consumed frames.
class SoloistPcmProcessor extends AudioWorkletProcessor {
    constructor() {
        super(); this.blocks = []; this.queued = 0; this.offset = 0; this.frames = 0;
        this.playing = false; this.complete = false; this.generation = 0; this.notified = 0; this.starved = false;
        this.port.onmessage = ({ data }) => {
            if (data.type === 'reset') {
                this.blocks = []; this.queued = 0; this.offset = 0; this.frames = 0; this.complete = false;
                this.generation = data.generation; this.playing = Boolean(data.playing); this.notified = 0;
            } else if (data.generation === this.generation) {
                if (data.type === 'block') {
                    const bytes = data.data;
                    if (!(bytes instanceof Uint8Array) || bytes.byteLength % 8 || bytes.byteLength > 65536
                        || this.queued + bytes.byteLength / 8 > 44100) { this.port.postMessage({ type: 'error', generation: this.generation }); return; }
                    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pcm = new Float32Array(bytes.byteLength / 4);
                    for (let index = 0; index < pcm.length; index++) pcm[index] = view.getInt32(index * 4, true) / 2147483648;
                    this.blocks.push(pcm); this.queued += pcm.length / 2;
                } else if (data.type === 'complete') this.complete = true;
                else if (data.type === 'play') this.playing = Boolean(data.playing);
            }
        };
    }
    process(_inputs, outputs) {
        const output = outputs[0]; if (!output?.length) return true;
        const count = output[0].length;
        let consumed = 0;
        if (this.playing) {
            for (let frame = 0; frame < count && this.blocks.length; frame++) {
                const block = this.blocks[0];
                output[0][frame] = block[this.offset]; if (output[1]) output[1][frame] = block[this.offset + 1];
                this.offset += 2; this.queued--; this.frames++; consumed++;
                if (this.offset === block.length) { this.blocks.shift(); this.offset = 0; }
            }
        }
        this.notified += count;
        const starved = this.playing && consumed < count && !this.complete;
        if (this.notified >= 2048 || starved !== this.starved || (this.playing && this.complete && !this.queued)) {
            this.starved = starved;
            this.notified = 0;
            this.port.postMessage({ type: 'state', generation: this.generation, frames: this.frames,
                queued: this.queued, buffering: this.playing && !this.queued && !this.complete,
                ended: this.playing && this.complete && !this.queued });
        }
        return true;
    }
}
registerProcessor('folia-soloist-pcm', SoloistPcmProcessor);
