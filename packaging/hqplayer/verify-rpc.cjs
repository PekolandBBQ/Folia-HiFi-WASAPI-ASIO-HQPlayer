const { fork } = require('node:child_process');
const { createRpc, handshake } = require('../../electron/hqplayer/rpc.cjs');

// CI handshake uses the same versioned messages without requiring HQPlayer, Electron or a DAC.
function createNodeRpc(entry, options = {}) {
    return createRpc(entry, { ...options, fork: file => {
        const child = fork(file, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        child.postMessage = value => child.send(value); return child;
    } });
}
async function verify(entry, release) {
    const rpc = createNodeRpc(entry, { timeoutMs: 5000 });
    try { await handshake(rpc, release.version); } finally { await rpc.dispose(); }
}
module.exports = { createNodeRpc, verify };
