const fs = require('node:fs/promises');
const path = require('node:path');
const { createFileServer } = require('../media/fileServer.cjs');

// Reuse completed original downloads without exposing paths or replacing the durable renderer cache.
function createSourceCache({ maxEntries = 3, ttlMs = 120000, leaseMs = 5000, media = createFileServer() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 8 || !(ttlMs > 0) || !(leaseMs > 0)) throw new Error('Invalid source cache limits');
    const entries = new Map(), owned = new Set(); let disposed = false;
    const key = ({ url, trackKey }) => JSON.stringify([url, trackKey || '']);
    const protectedReader = entry => entry.handle?.activeReaders?.() > 0 || entry.leaseUntil > Date.now();
    function cleanup(entry) {
        if (entry.cleanupTask) return entry.cleanupTask;
        if (!entry.retired || !entry.released || protectedReader(entry)) return Promise.resolve();
        entry.handle?.revoke();
        const task = (async () => {
            for (let attempt = 0; attempt < 20; attempt++) {
                try {
                    // Only a directory claimed from the native staging convention may be removed.
                    const actual = await fs.realpath(entry.directory);
                    if (actual.toLowerCase() !== entry.directory.toLowerCase()) throw new Error('Native cache directory changed');
                    await fs.rm(entry.directory, { recursive: true, force: true }); owned.delete(entry); return;
                } catch (error) {
                    if (error.code === 'ENOENT') { owned.delete(entry); return; }
                    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 19) return;
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
        })().finally(() => { if (entry.cleanupTask === task) entry.cleanupTask = null; });
        entry.cleanupTask = task; return task;
    }
    function retire(entry) {
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        entry.retired = true;
        // A returned URL has a brief lease to let its first HTTP request reach the server.
        if (entry.leaseUntil <= Date.now()) entry.handle?.retire();
        void cleanup(entry);
    }
    function sweep() {
        for (const entry of owned) {
            if (!entry.retired && entry.released && (entry.failed || (entry.complete && entry.expires <= Date.now() && !protectedReader(entry)))) retire(entry);
            if (entry.retired) { if (entry.leaseUntil <= Date.now()) entry.handle?.retire(); void cleanup(entry); }
        }
        const retained = [...entries.values()].filter(entry => entry.released && entry.complete);
        while (retained.length > maxEntries) {
            const index = retained.findIndex(entry => !protectedReader(entry));
            if (index < 0) break;
            retire(retained.splice(index, 1)[0]);
        }
    }
    const timer = setInterval(sweep, Math.min(ttlMs, leaseMs, 1000)); timer.unref?.();
    function track(input) {
        if (disposed) return null;
        const directory = path.resolve(input.directory), file = path.resolve(input.file);
        if (!path.basename(directory).startsWith('folia-native-audio-') || path.dirname(file).toLowerCase() !== directory.toLowerCase()
            || typeof input.url !== 'string' || !input.completion) throw new Error('Invalid native cache source');
        const entry = { key: key(input), directory, file, contentType: input.contentType, complete: false, failed: false,
            released: false, retired: false, leaseUntil: 0, expires: Date.now() + ttlMs, handle: null, publishing: null, cleanupTask: null };
        const previous = entries.get(entry.key); if (previous) retire(previous);
        entries.set(entry.key, entry); owned.add(entry);
        entry.ready = Promise.resolve(input.completion).then(async () => {
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size <= 44 || stat.size > 2 * 1024 ** 3) throw new Error('Invalid completed source');
            entry.complete = true; sweep(); return true;
        }).catch(() => { entry.failed = true; entry.leaseUntil = 0; retire(entry); return false; });
        return entry;
    }
    function reserveLease(entry) {
        // At most three concurrent leased sources; the current staging transfer is not a retained cache slot.
        const leased = [...owned].filter(item => item !== entry && protectedReader(item)).length;
        if (leased >= maxEntries) return false;
        entry.leaseUntil = Date.now() + leaseMs; entry.expires = Date.now() + ttlMs;
        return true;
    }
    async function read(input) {
        const entry = entries.get(key(input)); if (disposed || !entry || entry.retired) return null;
        if (!reserveLease(entry)) return null;
        if (!await entry.ready || entry.retired || disposed) return null;
        try {
            if (!entry.publishing) entry.publishing = media.add(entry.file, { contentType: typeof entry.contentType === 'function'
                ? entry.contentType() || 'application/octet-stream' : entry.contentType || 'application/octet-stream' }).then(handle => {
                entry.handle = handle; if (entry.retired || disposed) { handle.revoke(); return null; } return handle;
            });
            const handle = await entry.publishing;
            // Slow downloads/publication can outlive the reservation. Grant the
            // returned URL a full lease only if capacity is still available.
            if (!handle || entry.retired || disposed || !reserveLease(entry)) return null;
            return { url: handle.url };
        } catch { retire(entry); return null; }
    }
    return { track, read, release(entry) {
        if (!entry || !owned.has(entry)) return;
        entry.released = true; entry.expires = Date.now() + ttlMs; sweep(); return cleanup(entry);
    }, async dispose() {
        disposed = true; clearInterval(timer); media.close();
        const disposing = [...owned];
        for (const entry of disposing) { entry.released = true; entry.leaseUntil = 0; retire(entry); }
        await Promise.allSettled(disposing.map(async entry => {
            await entry.ready;
            for (let attempt = 0; attempt < 20 && entry.handle?.activeReaders?.() > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
            await cleanup(entry);
        }));
    } };
}
module.exports = { createSourceCache };
