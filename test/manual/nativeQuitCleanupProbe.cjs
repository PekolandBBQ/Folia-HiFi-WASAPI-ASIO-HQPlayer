const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// A real Electron app.quit must wait for a created staging directory whose Promise resolves late.
// No DAC, HQPlayer, credentials, renderer, component binary or user profile is used.
if (process.versions.electron) {
    const { app } = require('electron');
    const directory = process.env.FOLIA_QUIT_PROBE_DIRECTORY;
    if (!directory || !path.isAbsolute(directory)) throw new Error('Missing isolated probe directory');
    app.setPath('userData', directory); app.setPath('temp', directory);
    app.whenReady().then(async () => {
        const sender = { isDestroyed: () => false, send() {} };
        const service = require('../../electron/nativeAudio/service.cjs').registerNativeAudio({
            app, ipcMain: { handle() {} }, isTrustedSender: candidate => candidate === sender,
            componentManager: { status: async () => ({ available: true, executable: 'unused.exe' }) },
            decoderResolver: async () => 'unused-ffmpeg.exe',
            hqplayerFactory: () => ({ dispose() {} }),
            helperFactory: () => ({ dispose() {}, request: async request => request.action === 'hello'
                ? { protocolMajor: 1, capabilities: ['integer-pcm', 'replaygain', 'format-telemetry'] }
                : { session: request.session } }),
        });
        const originalCreate = fsp.mkdtemp;
        fsp.mkdtemp = prefix => originalCreate(prefix).then(created => new Promise(resolve => {
            fs.writeFileSync(path.join(directory, 'created-path.json'), JSON.stringify(created));
            setTimeout(() => resolve(created), 200);
            setImmediate(() => app.quit());
        }));
        void service.handle({ sender }, { action: 'begin', session: 'quit-probe', backend: 'asio', deviceId: 'unused-driver' }).catch(() => {});
        setTimeout(() => { fs.writeFileSync(path.join(directory, 'timeout'), 'no quit'); app.exit(2); }, 5000).unref();
    });
} else {
    const { spawnSync } = require('node:child_process');
    const crypto = require('node:crypto');
    const workspace = path.resolve(__dirname, '../../..');
    const artifactRoot = path.join(workspace, 'artifacts/native-streaming-20261002');
    fs.mkdirSync(artifactRoot, { recursive: true });
    const directory = path.join(artifactRoot, `quit-probe-${crypto.randomUUID()}`);
    fs.mkdirSync(directory);
    const environment = { ...process.env, FOLIA_QUIT_PROBE_DIRECTORY: directory }; delete environment.ELECTRON_RUN_AS_NODE;
    const startedAt = new Date().toISOString();
    const result = spawnSync(require('electron'), [__filename], { env: environment, windowsHide: true, encoding: 'utf8', timeout: 12000 });
    const created = fs.existsSync(path.join(directory, 'created-path.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'created-path.json'), 'utf8')) : null;
    const report = { startedAt, finishedAt: new Date().toISOString(), directory, created, exitCode: result.status,
        pass: result.status === 0 && Boolean(created) && !fs.existsSync(created),
        residualStaging: created && fs.existsSync(created), error: result.error?.message, output: result.stdout, stderr: result.stderr };
    fs.writeFileSync(path.join(artifactRoot, `quit-probe-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
}
