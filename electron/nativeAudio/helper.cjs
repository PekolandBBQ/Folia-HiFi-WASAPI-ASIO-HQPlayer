const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { audioError, errorCode, diagnostic } = require('./errors.cjs');

// electron/nativeAudio/helper.cjs — bounded JSON-line RPC to the isolated audio driver host.
function createHelper(executable, onEvent, spawnProcess = spawn, timeoutMs = 15000) {
    let child = null, nextId = 0;
    const pending = new Map();
    const retiring = new Map(), lifetimes = new WeakMap();
    function observedExit(process) {
        const lifetime = lifetimes.get(process);
        if (!lifetime || lifetime.exited) return;
        lifetime.exited = true; retiring.delete(process);
        for (const resolve of lifetime.waiters) resolve();
        lifetime.waiters.clear();
    }
    async function waitForRetired() {
        // kill() only requests termination. Preserve the exact child owner until
        // its exit/close event, and do not spawn another driver while it is unknown.
        for (const lifetime of retiring.values()) {
            if (lifetime.exited) continue;
            await new Promise((resolve, reject) => {
                const done = () => { clearTimeout(timer); lifetime.waiters.delete(done); resolve(); };
                const timer = setTimeout(() => {
                    lifetime.waiters.delete(done); reject(audioError('COMPONENT_TIMEOUT', 'Previous driver exit is unconfirmed'));
                }, timeoutMs);
                lifetime.waiters.add(done);
                if (lifetime.exited) done();
            });
        }
    }
    function fail(error, process, notify = true) {
        if (child !== process) return;
        child = null;
        const lifetime = lifetimes.get(process);
        if (lifetime && !lifetime.exited) retiring.set(process, lifetime);
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
        pending.clear();
        if (notify) { diagnostic(error); onEvent({ event: 'error', errorCode: errorCode(error) }); }
    }
    function start() {
        if (child) return child;
        const process = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = process;
        lifetimes.set(process, { exited: false, waiters: new Set() });
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
        process.on('error', error => { fail(audioError('COMPONENT_CRASHED', error.message), process);
            try { process.kill(); } catch { /* Keep the owner unconfirmed until exit. */ } });
        process.on('exit', code => {
            observedExit(process); lines.close();
            fail(audioError('COMPONENT_CRASHED', `Audio driver host exited (${code}). ${diagnostics}`), process);
        });
        process.on('close', () => { observedExit(process); lines.close();
            fail(audioError('COMPONENT_CRASHED', 'Audio driver process closed'), process); });
        process.stdin.on('error', error => { fail(audioError('COMPONENT_CRASHED', error.message), process);
            try { process.kill(); } catch { /* Keep the owner unconfirmed until exit. */ } });
        return process;
    }
    async function request(command) {
        if (retiring.size) await waitForRetired();
        if (!child && command.action === 'stop') return Promise.resolve({ ok: true });
        const process = start();
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                fail(audioError('COMPONENT_TIMEOUT', 'Driver request exceeded deadline'), process);
                try { process.kill(); } catch { /* A failed kill is not an exit acknowledgement. */ }
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            process.stdin.write(JSON.stringify({ ...command, id }) + '\n');
        });
    }
    function dispose() {
        if (!child) return;
        const process = child;
        fail(audioError('CANCELLED', 'Audio driver host closed'), process, false);
        try { process.kill(); } catch { /* Wait for the owned process exit on the next request. */ }
    }
    return { request, dispose, waitForExit: waitForRetired };
}
module.exports = { createHelper };
