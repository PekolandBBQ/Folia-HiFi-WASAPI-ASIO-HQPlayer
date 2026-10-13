const path = require('node:path');
const { spawn } = require('node:child_process');

// Private development-appliance transport. Neither argv nor diagnostics contain a Spotify secret.
// This module is not registered in the renderer/preload API or enabled by default.
const failure = code => Object.assign(new Error(`Spotify Soloist: ${code}`), { code });
function createSoloistSshInvoker({ keyPath, knownHostsPath, spawnProcess = spawn, executable = 'ssh.exe', timeoutMs = 12000 } = {}) {
    if (![keyPath, knownHostsPath].every(value => typeof value === 'string' && path.isAbsolute(value))
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw failure('INVALID_REQUEST');
    return function invoke(surface, operation, payload = {}, { signal } = {}) {
        const operations = surface === 'pcm' ? ['prepare', 'status', 'close'] : surface === 'soloist' ? ['status', 'play', 'pause', 'seek'] : [];
        if (!operations.includes(operation)) return Promise.reject(failure('INVALID_REQUEST'));
        let input;
        try { input = JSON.stringify(payload); } catch { return Promise.reject(failure('INVALID_REQUEST')); }
        if (!input || Buffer.byteLength(input) > 16384) return Promise.reject(failure('INVALID_REQUEST'));
        if (signal?.aborted) return Promise.reject(failure('CANCELLED'));
        const command = `runuser -u folia -- /opt/folia/venv/bin/python /opt/folia/${surface}-control.py ${operation}${surface === 'soloist' ? ' --stdin-json' : ''}`;
        const arguments_ = ['-i', keyPath, '-p', '22821', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
            '-o', `UserKnownHostsFile=${knownHostsPath}`, 'root@127.0.0.1', command];
        return new Promise((resolve, reject) => {
            let child, timer, settled = false, length = 0, buffers = [];
            const finish = (error, value) => {
                if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
                buffers = [];
                if (error) { child?.kill(); reject(error); } else resolve(value);
            };
            const abort = () => finish(failure('CANCELLED'));
            try { child = spawnProcess(executable, arguments_, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
            catch { finish(failure('APPLIANCE_UNAVAILABLE')); return; }
            timer = setTimeout(() => finish(failure('CONTROL_TIMEOUT')), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
            child.on('error', () => finish(failure('APPLIANCE_UNAVAILABLE')));
            child.stdin.on('error', () => finish(failure('CONTROL_FAILED')));
            child.stdout.on('data', bytes => {
                if (settled) return;
                length += bytes.length; if (length > 65536) { finish(failure('CONTROL_RESPONSE_TOO_LARGE')); return; }
                buffers.push(Buffer.from(bytes));
            });
            child.on('close', code => {
                if (settled) return;
                if (code !== 0) { finish(failure('CONTROL_REJECTED')); return; }
                try {
                    const value = JSON.parse(Buffer.concat(buffers, length).toString('utf8'));
                    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
                    finish(null, value);
                } catch { finish(failure('CONTROL_PROTOCOL_INVALID')); }
            });
            child.stdin.end(input + '\n');
        });
    };
}
module.exports = { createSoloistSshInvoker };
