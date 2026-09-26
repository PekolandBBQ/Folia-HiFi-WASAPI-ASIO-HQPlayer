const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// electron/nativeAudio/helper.cjs — bounded JSON-line RPC to the isolated audio driver host.
function createHelper(executable, onEvent, spawnProcess = spawn) {
    let child = null, nextId = 0;
    const pending = new Map();
    function fail(error, process) {
        if (child !== process) return;
        child = null;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
        pending.clear();
        onEvent({ event: 'error', error: error.message });
    }
    function start() {
        if (child) return child;
        const process = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = process;
        let diagnostics = '';
        process.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4096); });
        const lines = createInterface({ input: process.stdout });
        lines.on('line', line => {
            if (child !== process) return;
            let message;
            try { message = JSON.parse(line); } catch { return; }
            if (message.event) { onEvent(message); return; }
            const item = pending.get(message.id);
            if (!item) return;
            clearTimeout(item.timer); pending.delete(message.id);
            if (message.ok) item.resolve(message.result);
            else item.reject(new Error(message.error || 'Audio driver request failed'));
        });
        process.on('error', error => fail(error, process));
        process.on('exit', code => {
            lines.close();
            fail(new Error(`Audio driver host exited (${code}). ${diagnostics}`), process);
        });
        process.stdin.on('error', error => fail(error, process));
        return process;
    }
    function request(command) {
        const process = start();
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                fail(new Error('Audio driver timed out; select the device again to retry'), process);
                process.kill();
            }, 15000);
            pending.set(id, { resolve, reject, timer });
            process.stdin.write(JSON.stringify({ ...command, id }) + '\n');
        });
    }
    function dispose() {
        if (!child) return;
        const process = child;
        fail(new Error('Audio driver host closed'), process);
        process.kill();
    }
    return { request, dispose };
}
module.exports = { createHelper };
