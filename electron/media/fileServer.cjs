const http = require('node:http');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

// Temporary, revocable loopback file handles shared by browser and native audio consumers.
function createFileServer() {
  const entries = new Map(), streams = new Set();
  let starting, port;
  const server = http.createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const entry = entries.get(req.url);
    if (!entry) { res.writeHead(404).end(); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (req.headers.origin) {
      let allowed = req.headers.origin === 'null';
      try { allowed ||= ['localhost', '127.0.0.1'].includes(new URL(req.headers.origin).hostname); } catch {}
      if (!allowed) { res.writeHead(403).end(); return; }
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Accept-Ranges', entry.complete ? 'bytes' : 'none');
    res.setHeader('Content-Type', entry.contentType);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (!entry.complete) {
      // Native preparation owns seeking against its growing cache. Before EOF an open-ended
      // HTTP request stays chunked and ignores Range, rather than pretending a prefix is a song.
      if (req.method === 'HEAD') { res.end(); return; }
      void streamGrowing(entry, res);
      return;
    }
    let start = 0, end = entry.size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        else start = Math.max(0, entry.size - Number(match[2]));
      } else start = -1;
      if (!Number.isSafeInteger(start) || start < 0 || start > end || end >= entry.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${entry.size}` }).end(); return;
      }
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(entry.file, { start, end }); streams.add(stream); entry.streams.add(stream);
    stream.on('error', () => res.destroy());
    stream.on('close', () => {
      streams.delete(stream); entry.streams.delete(stream);
      if (!res.writableEnded) res.destroy();
    });
    res.on('close', () => stream.destroy()); stream.pipe(res);
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  async function streamGrowing(entry, res) {
    if (streams.size >= 32) { res.writeHead(503).end(); return; }
    const controller = new AbortController();
    const stream = { destroy() { controller.abort(); res.destroy(); } };
    streams.add(stream); entry.streams.add(stream);
    res.on('close', () => controller.abort());
    let file;
    try {
      file = await fs.promises.open(entry.file, 'r');
      const bytes = Buffer.allocUnsafe(65536);
      let offset = 0;
      while (!controller.signal.aborted) {
        if (entry.failure) throw entry.failure;
        const stat = await file.stat();
        const available = Math.min(bytes.length, stat.size - offset);
        if (available > 0) {
          const { bytesRead } = await file.read(bytes, 0, available, offset);
          if (bytesRead > 0) {
            offset += bytesRead;
            // Copy the single bounded block because the HTTP socket may retain it until drain.
            if (!res.write(Buffer.from(bytes.subarray(0, bytesRead)))) await once(res, 'drain', { signal: controller.signal });
            continue;
          }
        }
        if (entry.complete && offset >= entry.size) { res.end(); break; }
        await delay(30, undefined, { signal: controller.signal });
      }
    } catch { if (!res.destroyed) res.destroy(); }
    finally { await file?.close().catch(() => {}); streams.delete(stream); entry.streams.delete(stream); }
  }
  async function start() {
    if (!starting) starting = new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
    await starting;
  }
  return {
    async add(file, { contentType = 'audio/wav' } = {}) {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size <= 44) throw new Error('Invalid audio source');
      await start();
      const key = `/${randomBytes(24).toString('hex')}.wav`;
      const entry = { file, size: stat.size, streams: new Set(), complete: true, contentType };
      entries.set(key, entry);
      return { url: `http://127.0.0.1:${port}${key}`, activeReaders: () => entry.streams.size, retire() { entries.delete(key); }, revoke() {
        const entry = entries.get(key); entries.delete(key); for (const stream of entry?.streams || []) stream.destroy();
      } };
    },
    async addGrowing(file, { completion, contentType = 'audio/ogg' }) {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size <= 0 || !completion || !['audio/wav', 'audio/ogg'].includes(contentType)) throw new Error('Invalid audio source');
      await start();
      const key = `/${randomBytes(24).toString('hex')}.${contentType === 'audio/ogg' ? 'ogg' : 'wav'}`;
      const entry = { file, size: null, streams: new Set(), complete: false, contentType, failure: null };
      entries.set(key, entry);
      const revoke = () => { entries.delete(key); for (const stream of entry.streams) stream.destroy(); };
      const completed = Promise.resolve(completion).then(async () => {
        if (entries.get(key) !== entry) return;
        const final = await fs.promises.stat(file);
        entry.size = final.size; entry.complete = true;
      });
      void completed.catch(error => { entry.failure = error; revoke(); });
      return { url: `http://127.0.0.1:${port}${key}`, revoke, retire() { entries.delete(key); }, completed, activeReaders: () => entry.streams.size };
    },
    clear() { entries.clear(); for (const stream of streams) stream.destroy(); },
    close() { this.clear(); server.close(); server.closeAllConnections(); },
  };
}
module.exports = { createFileServer };
