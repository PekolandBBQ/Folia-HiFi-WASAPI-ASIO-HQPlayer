const { audioError, diagnostic } = require('../nativeAudio/errors.cjs');

// Stable private IPC; component code runs outside Folia's main process and is never required here.
function createRpc(entry, { fork = (...args) => require('electron').utilityProcess.fork(...args), onEvent = () => {}, timeoutMs = 35000 } = {}) {
    const child = fork(entry, [], { stdio: 'pipe', serviceName: 'Folia HQPlayer component' });
    const pending = new Map(); let serial = 0, closed = false, closing = false, ownedPid = null;
    function releaseOwned() { if (ownedPid) { try { process.kill(ownedPid); } catch {} ownedPid = null; } }
    function fail(code, notify = true) {
        if (closed) return; closed = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(audioError(code)); }
        pending.clear(); releaseOwned();
        if (notify) onEvent({ event: 'error', errorCode: code });
    }
    child.on('message', message => {
        if (closed) return;
        if (message?.event === 'owned-process') { ownedPid = Number.isSafeInteger(message.pid) && message.pid > 0 ? message.pid : null; return; }
        if (message?.event) { onEvent(message); return; }
        const item = pending.get(message?.id); if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result); else item.reject(audioError(message.errorCode));
    });
    child.on('exit', () => fail(closing ? 'CANCELLED' : 'COMPONENT_CRASHED', !closing));
    child.on('error', () => { fail('COMPONENT_CRASHED'); child.kill(); });
    child.stderr?.on('data', bytes => diagnostic(audioError('NATIVE_REQUEST_FAILED', bytes.toString().slice(-4096))));
    // Consume bounded diagnostic chunks without retaining process output in memory.
    child.stdout?.on('data', () => {});
    function request(action, fields = {}) {
        if (closed) return Promise.reject(audioError('COMPONENT_CRASHED'));
        const id = ++serial;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { fail('COMPONENT_TIMEOUT'); child.kill(); }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try { child.postMessage({ id, action, ...fields }); } catch { fail('COMPONENT_CRASHED'); child.kill(); }
        });
    }
    async function dispose() {
        if (closed) return;
        closing = true;
        // Parent ownership is a fallback if the worker cannot finish its graceful disposal.
        releaseOwned();
        const timer = setTimeout(() => { fail('CANCELLED', false); child.kill(); }, 500);
        try { await request('dispose'); } catch {} finally { clearTimeout(timer); fail('CANCELLED', false); child.kill(); }
    }
    return { request, dispose };
}
const capabilities = ['local-file', 'playback-control', 'dsp-settings', 'single-instance', 'launch-options'];
async function handshake(rpc, version) {
    const hello = await rpc.request('hello', { protocolMajor: 1 });
    if (hello?.id !== 'hqplayer' || hello.protocolMajor !== 1 || hello.componentVersion !== version
        || !capabilities.every(value => hello.capabilities?.includes(value))) throw audioError('COMPONENT_INCOMPATIBLE');
    return hello;
}
module.exports = { createRpc, handshake };
