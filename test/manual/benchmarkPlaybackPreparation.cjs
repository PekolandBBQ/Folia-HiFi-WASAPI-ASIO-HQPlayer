const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createHQPlayerComponentManager } = require('../../electron/hqplayer/componentManager.cjs');
const { createHQPlayerComponentHost } = require('../../electron/hqplayer/client.cjs');
const { createNodeRpc, verify } = require('../../packaging/hqplayer/verify-rpc.cjs');

// Compare HEAD and working tree with fresh scratch profiles and an identical throttled silent WAV.
// Refuses an already-running HQPlayer; never sends Play or changes user DSP/device settings.
const root = process.cwd();
const output = path.resolve(process.argv[2] || '../artifacts/playback-preparation-20260930/cold');
fs.mkdirSync(output, { recursive: true });
const baseline = path.join(output, 'baseline');
// Keep baseline under the repository so its existing runtime dependencies resolve normally.
const baselineModules = path.join(root, 'node_modules/.cache/folia-preparation-baseline');
fs.mkdirSync(baseline, { recursive: true });
fs.mkdirSync(baselineModules, { recursive: true });
fs.cpSync(path.join(root, 'electron/nativeAudio'), baselineModules, { recursive: true });
for (const name of new Set([...fs.readdirSync(baselineModules).filter(name => name.endsWith('.cjs')), 'hqplayerHost.cjs', 'hqplayerDiscovery.cjs', 'hqplayerProtocol.cjs'])) {
    try { fs.writeFileSync(path.join(baselineModules, name), cp.execFileSync('git', ['show', `HEAD:electron/nativeAudio/${name}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })); }
    catch { /* New working-tree modules have no baseline equivalent. */ }
}
const bytes = Buffer.alloc(44 + 48000 * 2 * 4);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': bytes.length });
    for (let i = 0; i < 10; i++) {
        await sleep(300);
        response.write(bytes.subarray(Math.floor(bytes.length * i / 10), Math.floor(bytes.length * (i + 1) / 10)));
    }
    response.end();
});
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const results = [];
    try {
        for (const [label, moduleDirectory] of [['baseline', baselineModules], ['optimized', path.join(root, 'electron/nativeAudio')]]) {
            const processes = JSON.parse(cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | Select-Object Id) -Compress"], { encoding: 'utf8', windowsHide: true }));
            if (processes.length) throw new Error('HQPlayer is already running; refusing to disrupt a user session');
            const { HQPlayerProtocol } = require(path.join(baselineModules, 'hqplayerProtocol.cjs'));
            const external = new HQPlayerProtocol(); external.on('error', () => {});
            let running = false;
            try { await external.connect(); running = true; } catch {} finally { external.close(); }
            if (running) throw new Error('HQPlayer is already running; refusing to disrupt a user session');
            const profile = fs.mkdtempSync(path.join(output, `${label}-profile-`));
            const app = Object.assign(new EventEmitter(), { getPath: () => profile, getAppPath: () => root, isPackaged: false });
            const events = [];
            const sender = { mainFrame: {}, isDestroyed: () => false, send: (_channel, event) => events.push(event), session: { fetch: global.fetch } };
            const { registerNativeAudio } = require(path.join(moduleDirectory, 'service.cjs'));
            let hqplayerFactory;
            if (label === 'optimized') {
                const manager = createHQPlayerComponentManager({ app, verifyStaged: verify,
                    catalogPath: process.env.FOLIA_HQPLAYER_COMPONENT_CATALOG || path.resolve('../folia-hqplayer-component/artifacts/development-catalog.json') });
                await manager.install();
                hqplayerFactory = options => createHQPlayerComponentHost({ ...options, manager, rpcFactory: createNodeRpc });
            }
            const service = registerNativeAudio({ app, ipcMain: { handle() {} }, isTrustedSender: value => value === sender, componentManager: {}, ...(hqplayerFactory ? { hqplayerFactory } : {}) });
            const start = performance.now();
            try {
                await service.handle({ sender }, { action: 'begin', session: 'benchmark', backend: 'hqplayer', deviceId: 'hqplayer-local', url: `http://127.0.0.1:${server.address().port}/silence.wav` });
                const beginMs = performance.now() - start;
                const state = await service.handle({ sender }, { action: 'finish', session: 'benchmark' });
                results.push({ label, beginMs, readyMs: performance.now() - start, sampleRate: state.sampleRate, events: events.filter(event => event.event === 'progress') });
                console.log(label, `${results.at(-1).readyMs.toFixed(0)} ms`);
            } finally { app.emit('before-quit'); await sleep(1200); }
        }
    } finally {
        server.close();
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ baseline: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            conditions: 'Fresh scratch profiles, cold HQPlayer, identical 2-second silent PCM WAV, local HTTP transfer limited to 3 seconds; no Play command.', results }, null, 2));
    }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
