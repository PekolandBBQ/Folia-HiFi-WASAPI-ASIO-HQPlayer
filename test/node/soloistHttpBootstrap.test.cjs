const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { createSoloistHttpBootstrap } = require('../../electron/spotify/soloistHttpBootstrap.cjs');
const options = { keyPath: path.join(os.tmpdir(), 'isolated-test', 'appliance_id'), knownHostsPath: path.join(os.tmpdir(), 'isolated-test', 'known_hosts') };
const failureCode = (code, promise) => assert.rejects(promise, error => error.code === code && error.message === `Spotify Soloist: ${code}`);
function child() { const value = new EventEmitter(); value.stdout = new EventEmitter(); value.kill = () => { value.killed = true; }; return value; }

// Exercise the unchanged Windows path validation without mutating the host's
// path module or process platform. Every child remains an in-memory fixture.
function windowsBootstrapFactory() {
    const sourcePath = require.resolve('../../electron/spotify/soloistHttpBootstrap.cjs');
    const isolated = new Module(sourcePath, module); isolated.filename = sourcePath;
    const normal = isolated.require.bind(isolated);
    isolated.require = name => name === 'node:path' ? path.win32 : normal(name);
    isolated._compile(fs.readFileSync(sourcePath, 'utf8'), sourcePath); return isolated.exports.createSoloistHttpBootstrap;
}

test('bootstrap uses fixed static SSH with hidden process and private bounded stdout', async () => {
    let captured; const instance = child();
    const bootstrap = createSoloistHttpBootstrap({ ...options, spawnProcess: (exe, args, spawnOptions) => { captured = { exe, args, spawnOptions }; return instance; } });
    const pending = bootstrap();
    instance.stdout.emit('data', Buffer.from(JSON.stringify({ endpoint: 'http://127.0.0.1:28802', bearer: 'test_only_value', lifecycle: 'fake' })));
    instance.emit('close', 0); const value = await pending;
    assert.equal(value.endpoint, 'http://127.0.0.1:28802');
    assert.equal(captured.args.at(-1), 'runuser -u folia -- /opt/folia/venv/bin/python /opt/folia/pcm-http-bootstrap.py');
    assert.equal(captured.spawnOptions.windowsHide, true); assert.deepEqual(captured.spawnOptions.stdio, ['ignore', 'pipe', 'ignore']);
    assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(!captured.args.some(value => value.includes('bearer') || value.includes('spotify:')));
});
test('bootstrap pre-abort never launches SSH', async () => {
    let launches = 0; const controller = new AbortController(); controller.abort();
    const bootstrap = createSoloistHttpBootstrap({ ...options, spawnProcess: () => { launches++; return child(); } });
    await failureCode('CANCELLED', bootstrap({ signal: controller.signal })); assert.equal(launches, 0);
});
test('bootstrap process failure and excessive stdout stay sanitized', async () => {
    for (const mode of ['failed', 'large']) {
        const instance = child();
        const bootstrap = createSoloistHttpBootstrap({ ...options, spawnProcess: () => instance });
        const pending = bootstrap();
        if (mode === 'failed') instance.emit('close', 1); else instance.stdout.emit('data', Buffer.from('x'.repeat(4097)));
        await failureCode(mode === 'failed' ? 'APPLIANCE_UNAVAILABLE' : 'CONTROL_RESPONSE_TOO_LARGE', pending);
        assert.equal(instance.killed, true);
    }
});

test('trusted clean appliance ports use folia SSH and require its exact forwarded PCM endpoint', async () => {
    let captured; const instance = child();
    const bootstrap = createSoloistHttpBootstrap({ ...options, sshPort: 33991, pcmPort: 33992, user: 'folia',
        spawnProcess: (exe, args, spawnOptions) => { captured = { args, spawnOptions }; return instance; } });
    const pending = bootstrap();
    instance.stdout.emit('data', Buffer.from(JSON.stringify({ endpoint: 'http://127.0.0.1:33992', bearer: 'fake_private_value', lifecycle: 'fake' })));
    instance.emit('close', 0);
    assert.equal((await pending).endpoint, 'http://127.0.0.1:33992');
    assert.equal(captured.args[captured.args.indexOf('-p') + 1], '33991');
    assert.equal(captured.args.at(-2), 'folia@127.0.0.1');
    assert.equal(captured.args.at(-1), '/opt/folia/venv/bin/python /opt/folia/pcm-http-bootstrap.py');
    assert.ok(captured.args.includes('HostKeyAlgorithms=ssh-ed25519'));
    assert.equal(captured.spawnOptions.windowsHide, true);
    for (const endpoint of ['http://127.0.0.1:28802', 'http://localhost:33992', 'http://127.0.0.1:33992/']) {
        const wrong = child(); const read = createSoloistHttpBootstrap({ ...options, pcmPort: 33992, spawnProcess: () => wrong })();
        wrong.stdout.emit('data', Buffer.from(JSON.stringify({ endpoint }))); wrong.emit('close', 0);
        await failureCode('CONTROL_PROTOCOL_INVALID', read);
    }
});

test('main host ports and SSH username cannot contain renderer-provided commands or invalid numeric values', () => {
    for (const untrusted of [{ user: 'folia;echo secret' }, { user: 'other' }, { sshPort: '33991' }, { sshPort: 0 }, { pcmPort: 65536 }, { pcmPort: 33992.5 }])
        assert.throws(() => createSoloistHttpBootstrap({ ...options, ...untrusted }), error => error.code === 'INVALID_REQUEST');
});

test('Windows paths with spaces use one quoted normalized known_hosts value and no shell', async () => {
    let captured; const instance = child();
    const keyPath = 'C:\\Users\\Test User\\Folia state\\client-key', knownHostsPath = 'C:\\Users\\Test User\\Folia state\\known hosts';
    const bootstrap = windowsBootstrapFactory()({ keyPath, knownHostsPath, user: 'folia',
        executable: 'C:\\Program Files\\Folia\\ssh.exe', spawnProcess: (exe, args, spawnOptions) => {
            captured = { exe, args, spawnOptions }; return instance;
        } });
    const pending = bootstrap();
    instance.stdout.emit('data', Buffer.from(JSON.stringify({ endpoint: 'http://127.0.0.1:28802' }))); instance.emit('close', 0); await pending;
    assert.equal(captured.args[captured.args.indexOf('-i') + 1], keyPath);
    assert.ok(captured.args.includes('UserKnownHostsFile="C:/Users/Test User/Folia state/known hosts"'));
    assert.equal(captured.exe, 'C:\\Program Files\\Folia\\ssh.exe'); assert.equal(captured.spawnOptions.shell, false);
});

test('SSH paths reject quotes and all control characters before any process can launch', () => {
    for (const field of ['keyPath', 'knownHostsPath', 'executable']) {
        for (const character of ['"', '\0', '\n', '\r', '\t', '\x01', '\x7f']) {
            assert.throws(() => createSoloistHttpBootstrap({ ...options, [field]: path.join(os.tmpdir(), 'unsafe' + character + 'path'),
                spawnProcess: () => { throw Error('must not launch'); } }), { code: 'INVALID_REQUEST' });
        }
    }
});

test('relative SSH identity paths remain invalid with host and isolated Windows path semantics', () => {
    const windowsOptions = { keyPath: 'C:\\isolated-test\\appliance_id', knownHostsPath: 'C:\\isolated-test\\known_hosts' };
    for (const [createBootstrap, valid, relative] of [[createSoloistHttpBootstrap, options, 'relative/path'],
        [windowsBootstrapFactory(), windowsOptions, 'C:relative\\path']]) {
        for (const field of ['keyPath', 'knownHostsPath']) {
            assert.throws(() => createBootstrap({ ...valid, [field]: relative,
                spawnProcess: () => { throw Error('must not launch'); } }), { code: 'INVALID_REQUEST' });
        }
    }
});

test('a control failure preserves its sanitized result if killing an already reaped child throws', async () => {
    const instance = child(); instance.kill = () => { throw Error('private child state'); };
    const pending = createSoloistHttpBootstrap({ ...options, spawnProcess: () => instance })();
    assert.doesNotThrow(() => instance.emit('error', Error('private process failure')));
    await failureCode('APPLIANCE_UNAVAILABLE', pending);
});
