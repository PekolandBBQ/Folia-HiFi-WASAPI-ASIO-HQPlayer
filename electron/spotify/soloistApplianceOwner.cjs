const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { spotifyError } = require('./errors.cjs');

// electron/spotify/soloistApplianceOwner.cjs: main owns one QEMU child and a private COW disk per data directory.
// The caller must pin a clean, approved base; a user's paired development disk is never a base-image source.
const sessions = new Map();
const guestPorts = Object.freeze({ ssh: 22, musicAssistant: 8095, pcm: 8802, soloist: 4321 });
const fail = reason => spotifyError('unavailable', `appliance-${reason}`);
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value);
const keyOf = value => process.platform === 'win32' ? value.toLowerCase() : value;
const alive = child => child && Number.isInteger(child.pid) && child.pid > 0
    && child.exitCode == null && child.signalCode == null;
function validPublicKey(value) {
    if (typeof value !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value)) return false;
    const bytes = Buffer.from(value.slice(12), 'base64');
    return bytes.length === 51 && bytes.readUInt32BE(0) === 11 && bytes.subarray(4, 15).toString() === 'ssh-ed25519'
        && bytes.readUInt32BE(15) === 32;
}

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

// A crashed app can leave a lock, but a live or reused process ID always keeps it protected.
async function acquireLock(record) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { record.lockHandle = await fs.promises.open(record.lock, 'wx', 0o600); record.lockOwned = true; return; }
        catch (error) { if (error.code !== 'EEXIST' || attempt) throw fail('in-use'); }
        await regularPath(record.lock);
        const handle = await fs.promises.open(record.lock, 'r');
        let saved, before;
        try {
            before = await handle.stat({ bigint: true });
            if (before.size > 4096n) throw fail('in-use');
            saved = JSON.parse(await handle.readFile('utf8'));
        } catch { throw fail('in-use'); }
        finally { await handle.close(); }
        if (saved?.schema !== 1 || !Number.isInteger(saved.process) || saved.process <= 0
            || !/^[a-f0-9]{48}$/.test(saved.nonce || '') || processExists(saved.process)) throw fail('in-use');
        const current = await fs.promises.lstat(record.lock, { bigint: true });
        if (current.isSymbolicLink() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => before[field] !== current[field]))
            throw fail('in-use');
        await fs.promises.unlink(record.lock);
    }
}

async function regularPath(filename, directory = false) {
    const resolved = path.resolve(filename), root = path.parse(resolved).root;
    let current = root;
    for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) throw fail('unsafe-path');
    }
    const stat = await fs.promises.stat(resolved);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw fail('unsafe-path');
    return resolved;
}

async function verifyDigest(filename, algorithm, expected) {
    await regularPath(filename);
    const file = await fs.promises.open(filename, 'r');
    try {
        const before = await file.stat({ bigint: true }), hash = createHash(algorithm);
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await file.stat({ bigint: true }), current = await fs.promises.stat(filename, { bigint: true });
        if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => before[field] !== after[field])
            || current.dev !== after.dev || current.ino !== after.ino || hash.digest('hex') !== expected)
            throw fail('integrity');
    } finally { await file.close(); }
}

// Reserve all host forwards together; QEMU must acquire them itself after release, without retrying or taking another process's ports.
async function reserveLoopbackPorts(requested = {}) {
    const servers = [], ports = {};
    const release = async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); };
    try {
        for (const name of Object.keys(guestPorts)) {
            const server = net.createServer(); servers.push(server);
            await new Promise((resolve, reject) => {
                server.once('error', reject); server.listen(requested[name] || 0, '127.0.0.1', resolve);
            });
            ports[name] = server.address().port;
        }
        return { ports, release };
    } catch { await release(); throw fail('port-unavailable'); }
}

function runImageTool(record, args, capture = false) {
    return new Promise((resolve, reject) => {
        let child, timer, settled = false, length = 0, chunks = [];
        const finish = (error, value) => {
            if (settled) return; settled = true; clearTimeout(timer);
            record.abort.signal.removeEventListener('abort', cancel); chunks = [];
            if (error) { if (alive(child)) child.kill(); reject(error); } else resolve(value);
        };
        const cancel = () => finish(fail('cancelled'));
        if (record.abort.signal.aborted) { cancel(); return; }
        try { child = record.spawn(record.imageTool, args, { windowsHide: true, shell: false,
            stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] }); }
        catch { finish(fail('image-tool')); return; }
        child.on('error', () => finish(fail('image-tool')));
        child.stdout?.on('error', () => finish(fail('image-tool')));
        child.stdout?.on('data', bytes => {
            length += bytes.length;
            if (length > 16384) { finish(fail('image-response')); return; }
            chunks.push(Buffer.from(bytes));
        });
        child.once('close', code => finish(code === 0 ? null : fail('image-tool'), Buffer.concat(chunks, length).toString('utf8')));
        timer = setTimeout(() => finish(fail('image-timeout')), 60000);
        record.abort.signal.addEventListener('abort', cancel, { once: true });
        if (record.abort.signal.aborted) cancel();
    });
}

async function prepareOverlay(record) {
    const { overlay, metadata, base, integrity } = record;
    let exists = false;
    try { await regularPath(overlay); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
        await regularPath(metadata);
        const stat = await fs.promises.stat(metadata);
        if (stat.size > 4096) throw fail('overlay-metadata');
        let saved; try { saved = JSON.parse(await fs.promises.readFile(metadata, 'utf8')); } catch { throw fail('overlay-metadata'); }
        if (saved.schema !== 1 || saved.baseImage !== base || saved.baseSha512 !== integrity.baseImageSha512)
            throw fail('overlay-base-changed');
    } else {
        // Never overwrite or silently repair a partial/foreign disk. Only our random, newly-created temporary file is removed.
        try { await fs.promises.lstat(metadata); throw fail('overlay-metadata'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temporary = path.join(record.data, `appliance-${randomBytes(12).toString('hex')}.partial.qcow2`);
        try {
            await runImageTool(record, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', base, temporary, '16G']);
            if (record.abort.signal.aborted) throw fail('cancelled');
            await regularPath(temporary);
            await fs.promises.rename(temporary, overlay);
            await fs.promises.writeFile(metadata, JSON.stringify({ schema: 1, baseImage: base,
                baseSha512: integrity.baseImageSha512 }), { flag: 'wx', mode: 0o600 });
        } finally {
            try { await fs.promises.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    let info; try { info = JSON.parse(await runImageTool(record, ['info', '--output=json', '-f', 'qcow2', overlay], true)); }
    catch (error) { if (error.code === 'unavailable') throw error; throw fail('overlay-info'); }
    if (info.format !== 'qcow2' || !safePath(info['full-backing-filename'])
        || keyOf(path.resolve(info['full-backing-filename'])) !== keyOf(base)
        || !Number.isSafeInteger(info['virtual-size']) || info['virtual-size'] <= 0
        || info['virtual-size'] > 64 * 1024 ** 3 || info['data-file']) throw fail('overlay-info');
}

function attachQmp(record, child) {
    let buffer = '';
    record.monitorReady = false;
    let ready;
    record.monitor = new Promise((resolve, reject) => {
        let timer, settled = false;
        ready = error => {
            if (settled) return; settled = true; clearTimeout(timer);
            record.abort.signal.removeEventListener('abort', cancelled);
            child.off('error', failed); child.off('close', failed);
            error ? reject(error) : resolve();
        };
        const failed = () => ready(fail('start'));
        const cancelled = () => ready(fail('cancelled'));
        child.once('error', failed); child.once('close', failed);
        record.abort.signal.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => ready(fail('start-timeout')), record.startTimeoutMs);
        if (record.abort.signal.aborted) cancelled();
    });
    // A failed OS spawn can reject before its caller reaches the monitor wait.
    record.monitor.catch(() => {});
    record.write = execute => {
        if (!alive(child) || child.stdin?.destroyed || !child.stdin?.writable) return false;
        try { child.stdin.write(`${JSON.stringify({ execute, id: execute })}\n`, () => {}); return true; }
        catch { return false; }
    };
    // Neither console output nor stderr are forwarded. The private pipe carries QMP JSON only, and EPIPE never reaches app stdout.
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stdout?.on('data', bytes => {
        buffer += bytes.toString('utf8');
        if (buffer.length > 65536) { buffer = ''; if (alive(child)) child.kill(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            let message; try { message = JSON.parse(line); } catch { continue; }
            if (message.QMP) record.write('qmp_capabilities');
            if (message.id === 'qmp_capabilities' && Object.hasOwn(message, 'return')) {
                record.monitorReady = true; ready();
            }
        }
    });
}

async function cleanup(record) {
    if (record.cleanup) return record.cleanup;
    record.cleanup = (async () => {
        try {
            await record.reservation?.release(); record.reservation = null;
            await record.lockHandle?.close(); record.lockHandle = null;
            if (record.lockOwned) {
                await regularPath(record.lock);
                const saved = await fs.promises.readFile(record.lock, 'utf8');
                if (saved !== record.lockText) throw fail('lock-changed');
                await fs.promises.unlink(record.lock); record.lockOwned = false;
            }
        } finally { if (sessions.get(record.key) === record) sessions.delete(record.key); }
    })();
    return record.cleanup;
}

async function startRecord(record) {
    const wanted = () => { if (record.abort.signal.aborted) throw fail('cancelled'); };
    try {
        await fs.promises.mkdir(record.data, { recursive: true, mode: 0o700 });
        await regularPath(record.data, true); await regularPath(record.runtime, true);
        record.lockText = JSON.stringify({ schema: 1, process: process.pid, nonce: randomBytes(24).toString('hex') });
        await acquireLock(record); await record.lockHandle.writeFile(record.lockText);
        wanted();
        await Promise.all([verifyDigest(record.base, 'sha512', record.integrity.baseImageSha512),
            verifyDigest(record.executable, 'sha256', record.integrity.qemuSha256),
            verifyDigest(record.imageTool, 'sha256', record.integrity.qemuImgSha256),
            ...(record.seed ? [verifyDigest(record.seed.path, 'sha256', record.seed.sha256)] : []),
            ...(record.bootstrapSshHostKey ? [verifyDigest(record.bootstrapSshHostKey.path, 'sha256', record.bootstrapSshHostKey.sha256)] : [])]);
        wanted(); await prepareOverlay(record); wanted();
        record.reservation = await record.reserve(record.requestedPorts); wanted();
        const ports = Object.freeze({ ...record.reservation.ports });
        if (!validPorts(ports, true)) throw fail('port-unavailable');
        const forwards = Object.entries(guestPorts).map(([name, guestPort]) => `hostfwd=tcp:127.0.0.1:${ports[name]}-:${guestPort}`).join(',');
        const args = ['-accel', 'tcg,thread=multi', '-machine', 'q35', '-cpu', 'max', '-smp', '2', '-m', '3072',
            '-drive', `file=${record.overlay.replace(/,/g, ',,')},format=qcow2,if=virtio`,
            ...(record.seed ? ['-drive', `file=${record.seed.path.replace(/,/g, ',,')},format=raw,media=cdrom,readonly=on`] : []),
            ...(record.bootstrapSshPublicKey ? ['-fw_cfg', `name=opt/folia/ssh-public-key,string=${record.bootstrapSshPublicKey}`] : []),
            ...(record.bootstrapSshHostKey ? ['-fw_cfg', `name=opt/folia/ssh-host-private-key,file=${record.bootstrapSshHostKey.path.replace(/,/g, ',,')}`,
                '-fw_cfg', `name=opt/folia/ssh-host-public-key,string=${record.bootstrapSshHostKey.publicKey}`] : []),
            '-netdev', `user,id=folia,${forwards}`, '-device', 'virtio-net-pci,netdev=folia',
            '-display', 'none', '-serial', 'none', '-monitor', 'none', '-qmp', 'stdio', '-no-reboot'];
        await record.reservation.release(); record.reservation = null; wanted();
        const child = record.spawn(record.executable, args, { windowsHide: true, shell: false, cwd: record.runtime,
            stdio: ['pipe', 'pipe', 'ignore'] });
        record.child = child; attachQmp(record, child);
        record.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.on('error', () => {});
        child.once('exit', () => {
            record.phase = 'stopped'; cleanup(record).catch(() => { record.failure = 'cleanup'; });
        });
        await new Promise((resolve, reject) => {
            const failed = () => reject(fail('start'));
            child.once('error', failed); child.once('exit', failed);
            child.once('spawn', () => { child.off('error', failed); child.off('exit', failed); resolve(); });
        });
        await record.monitor;
        wanted();
        if (!alive(child)) throw fail('start');
        record.phase = 'running';
        record.lease = Object.freeze({ pid: child.pid, startedAt: new Date().toISOString(), ports, baseImage: record.base,
            overlayImage: record.overlay, owned: true, guestReady: false });
        return record.lease;
    } catch (error) {
        record.phase = 'stopped';
        if (alive(record.child)) { record.child.kill(); await waitForExit(record); }
        await cleanup(record);
        throw error.code === 'unavailable' ? error : fail('start');
    }
}

async function waitForExit(record) {
    let timer;
    try {
        await Promise.race([record.exited, new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail('stop-timeout')), record.stopTimeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

async function stopRecord(record) {
    if (record.stop) return record.stop;
    record.abort.abort();
    record.stop = (async () => {
        try { await record.started; } catch { return; }
        if (alive(record.child)) {
            // ACPI first lets Linux close its database and filesystem; QMP quit then bounds an unresponsive guest.
            // The final fallback can terminate only the exact ChildProcess we spawned.
            if (record.monitorReady) record.write('system_powerdown');
            try { await waitForExit(record); } catch { /* A bounded fallback terminates only this child. */ }
            if (alive(record.child) && record.monitorReady) {
                record.write('quit');
                try { await waitForExit(record); } catch { /* ChildProcess kill is the final bounded fallback. */ }
            }
            if (alive(record.child)) {
                record.child.kill();
                await waitForExit(record);
            }
        }
        await cleanup(record);
    })();
    return record.stop;
}

function validPorts(ports, all = false) {
    return ports && !Array.isArray(ports) && typeof ports === 'object'
        && Object.keys(ports).every(key => Object.hasOwn(guestPorts, key))
        && (!all || Object.keys(ports).length === 4)
        && Object.values(ports).every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
        && new Set(Object.values(ports)).size === Object.keys(ports).length;
}

function createSoloistApplianceOwner({ runtimeDirectory, baseImage, dataDirectory, integrity,
    ports = {}, bootstrapSeed, bootstrapSshPublicKey, bootstrapSshHostKey, spawnProcess = spawn, reservePorts = reserveLoopbackPorts, platform = process.platform,
    stopTimeoutMs = 8000, startTimeoutMs = 10000 } = {}) {
    if (process.type === 'renderer' || platform !== 'win32'
        || ![runtimeDirectory, baseImage, dataDirectory].every(safePath) || !validPorts(ports)
        || !integrity || !/^[a-f0-9]{128}$/.test(integrity.baseImageSha512 || '')
        || !['qemuSha256', 'qemuImgSha256'].every(key => /^[a-f0-9]{64}$/.test(integrity[key] || ''))
        || typeof spawnProcess !== 'function' || typeof reservePorts !== 'function'
        || !Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 10 || stopTimeoutMs > 30000
        || !Number.isInteger(startTimeoutMs) || startTimeoutMs < 10 || startTimeoutMs > 30000
        || (bootstrapSeed && (!safePath(bootstrapSeed.path) || !/^[a-f0-9]{64}$/.test(bootstrapSeed.sha256 || '')))
        || (bootstrapSshHostKey && (!safePath(bootstrapSshHostKey.path) || !/^[a-f0-9]{64}$/.test(bootstrapSshHostKey.sha256 || '')
            || !validPublicKey(bootstrapSshHostKey.publicKey) || !bootstrapSshPublicKey))
        || (bootstrapSshPublicKey != null && !validPublicKey(bootstrapSshPublicKey))) throw fail('configuration');
    const runtime = path.resolve(runtimeDirectory), base = path.resolve(baseImage), data = path.resolve(dataDirectory);
    if (keyOf(base) === keyOf(path.join(data, 'appliance.qcow2')) || keyOf(base).startsWith(keyOf(data + path.sep))) throw fail('configuration');
    const pinned = Object.freeze({ ...integrity }), requestedPorts = Object.freeze({ ...ports });
    const seed = bootstrapSeed ? Object.freeze({ path: path.resolve(bootstrapSeed.path), sha256: bootstrapSeed.sha256 }) : null;
    // The private key bytes never enter a seed, command string, lease or log; QEMU reads the pinned owner-only file directly.
    const hostKey = bootstrapSshHostKey ? Object.freeze({ path: path.resolve(bootstrapSshHostKey.path),
        sha256: bootstrapSshHostKey.sha256, publicKey: bootstrapSshHostKey.publicKey }) : null;
    const signature = JSON.stringify([runtime, base, pinned.baseImageSha512, pinned.qemuSha256, pinned.qemuImgSha256,
        ...Object.keys(guestPorts).map(name => requestedPorts[name] || 0), seed, bootstrapSshPublicKey, hostKey]);
    let record, pending, closing, closed = false;
    const owner = {};
    const api = {
        start() {
            if (closed) return Promise.reject(fail('closed'));
            if (record?.phase !== 'stopped' && pending) return pending;
            const key = keyOf(data), existing = sessions.get(key);
            if (existing?.phase === 'stopped') {
                pending = cleanup(existing).then(() => api.start());
                return pending;
            }
            if (existing && (existing.signature !== signature || existing.abort.signal.aborted)) return Promise.reject(fail('in-use'));
            record = existing || { key, signature, runtime, base, data, seed, bootstrapSshPublicKey, bootstrapSshHostKey: hostKey, integrity: pinned, requestedPorts,
                executable: path.join(runtime, 'qemu-system-x86_64.exe'), imageTool: path.join(runtime, 'qemu-img.exe'),
                overlay: path.join(data, 'appliance.qcow2'), metadata: path.join(data, 'appliance.json'), lock: path.join(data, 'appliance.lock'),
                spawn: spawnProcess, reserve: reservePorts, stopTimeoutMs, startTimeoutMs, abort: new AbortController(), owners: new Set(), phase: 'starting' };
            record.owners.add(owner);
            if (!existing) { sessions.set(key, record); record.started = startRecord(record); }
            pending = record.started.then(lease => { if (closed) throw fail('closed'); return lease; });
            return pending;
        },
        status() { return Object.freeze({ state: closed ? 'closed' : record?.phase || 'stopped',
            ...(record?.phase === 'running' && alive(record.child) ? { ...record.lease } : {}),
            ...(record?.failure ? { failure: record.failure } : {}) }); },
        waitForExit() {
            if (!record) return Promise.reject(fail('not-started'));
            return record.started.then(() => record.exited);
        },
        close() {
            if (closing) return closing;
            closed = true;
            closing = (async () => {
                if (!record) return;
                record.owners.delete(owner);
                if (!record.owners.size) await stopRecord(record);
            })();
            return closing;
        },
    };
    return Object.freeze(api);
}
module.exports = { createSoloistApplianceOwner };
