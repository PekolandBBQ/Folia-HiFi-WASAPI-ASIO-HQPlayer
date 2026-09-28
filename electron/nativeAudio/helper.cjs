const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { audioError, errorCode, diagnostic } = require('./errors.cjs');

// electron/nativeAudio/helper.cjs — bounded JSON-line RPC to the isolated audio driver host.
function createHelper(executable, onEvent, spawnProcess = spawn, timeoutMs = 15000) {
    let child = null, nextId = 0;
    const pending = new Map();
    function fail(error, process, notify = true) {
        if (child !== process) return;
        child = null;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
        pending.clear();
        if (notify) { diagnostic(error); onEvent({ event: 'error', errorCode: errorCode(error) }); }
    }
    function start() {
        if (child) return child;
        const process = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = process;
        let diagnostics = '';
        process.stderr.on('data', data => {
            diagnostics = (diagnostics + data).slice(-4096);
            // Keep driver details in the sanitized host log even when the helper survives.
            diagnostic(audioError('NATIVE_REQUEST_FAILED', data.toString().slice(-4096)));
        });
        const lines = createInterface({ input: process.stdout });
        lines.on('line', line => {
            if (child !== process) return;
            let message;
            try { message = JSON.parse(line); } catch { return; }
            if (message.event) {
                if (message.event === 'error') {
                    const error = audioError(message.errorCode, message.error);
                    diagnostic(error);
                    onEvent({ event: 'error', session: message.session, errorCode: errorCode(error) });
                } else onEvent(message);
                return;
            }
            const item = pending.get(message.id);
            if (!item) return;
            clearTimeout(item.timer); pending.delete(message.id);
            if (message.ok) item.resolve(message.result);
            else { const error = audioError(message.errorCode, message.error); diagnostic(error); item.reject(error); }
        });
        process.on('error', error => fail(audioError('COMPONENT_CRASHED', error.message), process));
        process.on('exit', code => {
            lines.close();
            fail(audioError('COMPONENT_CRASHED', `Audio driver host exited (${code}). ${diagnostics}`), process);
        });
        process.stdin.on('error', error => fail(audioError('COMPONENT_CRASHED', error.message), process));
        return process;
    }
    function request(command) {
        if (!child && command.action === 'stop') return Promise.resolve({ ok: true });
        const process = start();
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                fail(audioError('COMPONENT_TIMEOUT', 'Driver request exceeded deadline'), process);
                process.kill();
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            process.stdin.write(JSON.stringify({ ...command, id }) + '\n');
        });
    }
    function dispose() {
        if (!child) return;
        const process = child;
        fail(audioError('CANCELLED', 'Audio driver host closed'), process, false);
        process.kill();
    }
    return { request, dispose };
}
module.exports = { createHelper };
