const path = require('node:path');
const { spawn } = require('node:child_process');
const failure = code => Object.assign(new Error(`Spotify Soloist: ${code}`), { code });
const safeAbsolutePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f"]/.test(value);

// One fixed SSH command, no source URI or secret in argv. Its bounded stdout is
// a private runtime credential captured only in the main-process closure.
function createSoloistHttpBootstrap({ keyPath, knownHostsPath, sshPort = 22821, user = 'root', pcmPort = 28802,
    spawnProcess = spawn, executable = 'ssh.exe', timeoutMs = 12000 } = {}) {
    if (process.type === 'renderer' || ![keyPath, knownHostsPath].every(safeAbsolutePath)
        || typeof executable !== 'string' || !executable || /[\x00-\x1f\x7f"]/.test(executable)
        || ![sshPort, pcmPort].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 65535)
        || !['root', 'folia'].includes(user)
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw failure('INVALID_REQUEST');
    return function bootstrap({ signal } = {}) {
        if (signal?.aborted) return Promise.reject(failure('CANCELLED'));
        const arguments_ = ['-i', keyPath, '-p', String(sshPort), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
            '-o', `UserKnownHostsFile="${knownHostsPath.replace(/\\/g, '/')}"`, ...(user === 'folia' ? ['-o', 'HostKeyAlgorithms=ssh-ed25519'] : []), `${user}@127.0.0.1`,
            (user === 'root' ? 'runuser -u folia -- ' : '') + '/opt/folia/venv/bin/python /opt/folia/pcm-http-bootstrap.py'];
        return new Promise((resolve, reject) => {
            let child, timer, settled = false, length = 0, blocks = [];
            const finish = (error, value) => {
                if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
                blocks.forEach(block => block.fill(0)); blocks = [];
                if (error) { try { child?.kill(); } catch { /* The owned control child may already have exited. */ } reject(error); } else resolve(value);
            };
            const abort = () => finish(failure('CANCELLED'));
            try { child = spawnProcess(executable, arguments_, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
            catch { finish(failure('APPLIANCE_UNAVAILABLE')); return; }
            timer = setTimeout(() => finish(failure('CONTROL_TIMEOUT')), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
            child.on('error', () => finish(failure('APPLIANCE_UNAVAILABLE')));
            child.stdout.on('data', bytes => {
                if (settled) return;
                length += bytes.length; if (length > 4096) { finish(failure('CONTROL_RESPONSE_TOO_LARGE')); return; }
                blocks.push(Buffer.from(bytes));
            });
            child.on('close', code => {
                if (settled) return;
                if (code !== 0) { finish(failure('APPLIANCE_UNAVAILABLE')); return; }
                try {
                    const output = Buffer.concat(blocks, length); let value;
                    try { value = JSON.parse(output.toString('utf8')); } finally { output.fill(0); }
                    if (!value || Array.isArray(value) || typeof value !== 'object' || value.endpoint !== `http://127.0.0.1:${pcmPort}`) throw new Error();
                    finish(null, value);
                } catch { finish(failure('CONTROL_PROTOCOL_INVALID')); }
            });
        });
    };
}
module.exports = { createSoloistHttpBootstrap };
