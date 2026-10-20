const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// electron/hqplayer/wavReplayStore.cjs — private session PCM spool; readers never consume the producer's bytes.
class WavReplayStore {
    constructor() { this.bytes = 0; this.closed = false; this.pending = null; }
    async open() {
        this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-hq-wav-'));
        this.file = path.join(this.directory, 'session.pcm');
        try { this.handle = await fs.open(this.file, 'wx+'); }
        catch (error) { await fs.rmdir(this.directory).catch(() => {}); throw error; }
    }
    async append(chunk) {
        if (this.closed) throw Object.assign(Error('WAV 会话已停止'), { code: 'CANCELLED' });
        const pending = (async () => {
            let offset = 0;
            while (offset < chunk.length) {
                const { bytesWritten } = await this.handle.write(chunk, offset, chunk.length - offset, this.bytes + offset);
                if (!bytesWritten) throw Object.assign(Error('WAV 临时缓存写入未取得进展'), { code: 'DECODE_FAILED' });
                offset += bytesWritten;
            }
            this.bytes += chunk.length;
        })();
        this.pending = pending;
        try { await pending; } finally { if (this.pending === pending) this.pending = null; }
    }
    async read(offset, maximum) {
        const buffer = Buffer.allocUnsafe(Math.min(maximum, Math.max(0, this.bytes - offset)));
        if (!buffer.length) return buffer;
        const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, offset);
        return buffer.subarray(0, bytesRead);
    }
    async close() {
        this.closed = true;
        await this.pending?.catch(() => {});
        await this.handle?.close(); this.handle = null;
        // Delete only the two paths created by this instance; never recursively remove a supplied directory.
        const remove = async operation => { try { await operation(); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
        if (this.file) await remove(() => fs.unlink(this.file));
        if (this.directory) await remove(() => fs.rmdir(this.directory));
    }
}
module.exports = { WavReplayStore };
