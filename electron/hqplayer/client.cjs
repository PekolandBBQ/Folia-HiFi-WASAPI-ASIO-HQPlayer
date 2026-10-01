const { createHQPlayerComponentManager } = require('./componentManager.cjs');
const { createRpc, handshake } = require('./rpc.cjs');
const { audioError } = require('../nativeAudio/errors.cjs');

// Optional HQPlayer facade. No component process starts in the browser/WASAPI/ASIO playback path.
function createHQPlayerComponentHost({ app, configPath, onState = () => {}, onError = () => {},
    manager = createHQPlayerComponentManager({ app }), rpcFactory = createRpc } = {}) {
    let rpc = null, starting = null, silent = false, generation = 0, managing = false;
    async function ensure() {
        if (managing) throw audioError('INVALID_REQUEST');
        if (rpc) return rpc;
        if (starting) return starting;
        const ticket = generation;
        starting = (async () => {
            const installed = await manager.status();
            if (!installed.available) throw audioError(installed.errorCode || 'COMPONENT_UNAVAILABLE');
            const next = rpcFactory(installed.executable, { onEvent: event => {
                if (ticket !== generation) return;
                if (event.event === 'diagnostic' && event.detail?.event === 'playlist-load') {
                    const { attempt, attempts, coldConnection, result, code } = event.detail;
                    console.info('[HQPlayer preparation]', JSON.stringify({ attempt, attempts, coldConnection, result, code }));
                    return;
                }
                if (event.event === 'state') onState(event.state);
                if (event.event === 'error') { if (['COMPONENT_CRASHED', 'COMPONENT_TIMEOUT'].includes(event.errorCode)) rpc = null; onError(audioError(event.errorCode)); }
            } });
            try {
                await handshake(next, installed.version);
                await next.request('initialize', { configPath, silent });
                if (ticket !== generation) throw audioError('CANCELLED');
                rpc = next; return next;
            } catch (error) { await next.dispose(); throw error; }
        })().finally(() => { if (ticket === generation) starting = null; });
        return starting;
    }
    const invoke = async (action, args) => (await ensure()).request(action, { args });
    async function dispose() {
        ++generation; const old = rpc; const pending = starting; rpc = null; starting = null;
        await old?.dispose();
        if (pending) await pending.catch(() => {});
    }
    async function configuration() {
        const component = await manager.status(); const { executable, ...publicComponent } = component;
        if (!component.available) return { available: false, component: publicComponent, errorCode: component.errorCode || 'COMPONENT_UNAVAILABLE' };
        return { ...await invoke('configuration', []), component: publicComponent };
    }
    async function manage(action) {
        if (managing || !['install', 'uninstall', 'rollback'].includes(action)) throw audioError('INVALID_REQUEST');
        managing = true;
        try { await dispose(); await manager[action](); managing = false; return configuration(); } finally { managing = false; }
    }
    return { configuration, dispose, manage,
        configure: async value => { await invoke('configure', [value]); return configuration(); },
        setSilent: value => { silent = value === true; if (rpc) void rpc.request('setSilent', { args: [silent] }).catch(onError); },
        ...Object.fromEntries(['device', 'prepare', 'checkExisting', 'authorizeExisting', 'load', 'command', 'stop', 'shutdown', 'dspSettings', 'validateExecutable']
            .map(action => [action, (...args) => action === 'stop' && !rpc && !starting ? Promise.resolve() : invoke(action, args)])) };
}
module.exports = { createHQPlayerComponentHost };
