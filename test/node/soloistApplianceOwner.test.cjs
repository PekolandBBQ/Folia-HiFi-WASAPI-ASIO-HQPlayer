const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { createSoloistApplianceOwner } = require('../../electron/spotify/soloistApplianceOwner.cjs');

// Real child pipes exercise process ownership and QMP shutdown without starting a VM or touching paired disks.
const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 2000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() >= end) throw Error('fixture wait timed out'); await pause(10); }
}
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-owner-test-'));
    const runtime = path.join(root, 'runtime'), data = path.join(root, 'data');
    await fs.mkdir(runtime); const base = path.join(root, 'clean-public-base.qcow2');
    const payloads = { base: Buffer.from('pristine public base fixture'), qemu: Buffer.from('qemu executable fixture'), img: Buffer.from('qemu-img fixture') };
    await fs.writeFile(base, payloads.base); await fs.writeFile(path.join(runtime, 'qemu-system-x86_64.exe'), payloads.qemu);
    await fs.writeFile(path.join(runtime, 'qemu-img.exe'), payloads.img);
    const imageScript = path.join(root, 'image.cjs'), qmpScript = path.join(root, 'qmp.cjs');
    await fs.writeFile(imageScript, `const fs=require('node:fs');const a=process.argv.slice(2);
        if(a[0]==='create'){fs.writeFileSync(a.at(-2),JSON.stringify({format:'qcow2','full-backing-filename':a[a.indexOf('-b')+1],'virtual-size':17179869184}));}
        else process.stdout.write(fs.readFileSync(a.at(-1)));`);
    await fs.writeFile(qmpScript, `const readline=require('node:readline');setInterval(()=>{},1000);
        process.stdout.write(JSON.stringify({QMP:{version:{qemu:{major:10}}}})+'\\n');
        readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
        if(m.execute==='qmp_capabilities')process.stdout.write(JSON.stringify({return:{},id:m.id})+'\\n');
        if(m.execute==='quit')process.exit(0);});`);
    const calls = [], children = [], owners = [], pipeErrors = [];
    const spawnProcess = (file, args, flags) => {
        calls.push({ file, args, flags });
        if (file.endsWith('qemu-img.exe')) {
            if (options.imageFailure) return spawn(process.execPath, ['-e', 'process.exit(2)'], flags);
            return spawn(process.execPath, [imageScript, ...args], flags);
        }
        if (options.spawnFailure) return spawn(path.join(root, 'missing-command.exe'), [], flags);
        const child = spawn(process.execPath, [qmpScript], flags);
        child.stdin.on('error', error => pipeErrors.push(error.code)); children.push(child); return child;
    };
    const config = { runtimeDirectory: runtime, baseImage: base, dataDirectory: data, platform: 'win32', stopTimeoutMs: 100,
        integrity: { baseImageSha512: digest(payloads.base, 'sha512'), qemuSha256: digest(payloads.qemu), qemuImgSha256: digest(payloads.img) },
        spawnProcess };
    const create = changes => { const owner = createSoloistApplianceOwner({ ...config, ...changes }); owners.push(owner); return owner; };
    t.after(async () => {
        await Promise.allSettled(owners.map(owner => owner.close()));
        children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
        const actual = path.resolve(root), expectedRoot = path.resolve(os.tmpdir()) + path.sep;
        assert.ok(actual.startsWith(expectedRoot) && path.basename(actual).startsWith('folia-owner-test-'));
        await fs.rm(actual, { recursive: true, force: true });
    });
    return { root, runtime, base, data, calls, children, pipeErrors, create, config };
}

test('one owned real child, dynamic loopback forwards, COW base unchanged, graceful QMP close', async t => {
    const value = await fixture(t); const original = await fs.readFile(value.base), owner = value.create();
    const first = owner.start(); assert.equal(owner.start(), first);
    const lease = await first; assert.equal(owner.status().state, 'running'); assert.equal(lease.guestReady, false);
    assert.equal(lease.owned, true); assert.equal(value.children.length, 1); assert.equal(lease.pid, value.children[0].pid);
    const qemu = value.calls.find(call => call.file.endsWith('qemu-system-x86_64.exe'));
    assert.equal(qemu.flags.windowsHide, true); assert.equal(qemu.flags.shell, false);
    assert.deepEqual(qemu.flags.stdio, ['pipe', 'pipe', 'ignore']);
    assert.ok(qemu.args.includes('tcg,thread=multi')); assert.ok(qemu.args.includes('none'));
    const forward = qemu.args[qemu.args.indexOf('-netdev') + 1];
    for (const port of Object.values(lease.ports)) assert.match(forward, new RegExp(`hostfwd=tcp:127\\.0\\.0\\.1:${port}-:`));
    assert.equal(new Set(Object.values(lease.ports)).size, 4);
    await until(() => value.children[0].stdout.listenerCount('data') > 0); await pause(80);
    await owner.close(); assert.equal(owner.status().state, 'closed'); assert.equal(value.children[0].exitCode, 0);
    assert.deepEqual(await fs.readFile(value.base), original); assert.equal(await fs.stat(path.join(value.data, 'appliance.qcow2')).then(() => true), true);
    await assert.rejects(fs.stat(path.join(value.data, 'appliance.lock')), { code: 'ENOENT' });
    await assert.rejects(owner.start(), /appliance-closed/);
});

test('two matching owner handles share one process; close cannot kill the remaining owner', async t => {
    const value = await fixture(t), first = value.create(), second = value.create();
    const [one, two] = await Promise.all([first.start(), second.start()]); assert.equal(one.pid, two.pid);
    await first.close(); assert.equal(second.status().state, 'running'); assert.equal(value.children[0].exitCode, null);
    await second.close(); assert.equal(value.children.length, 1); assert.notEqual(value.children[0].exitCode ?? value.children[0].signalCode, null);
});

test('concurrent close calls share completion instead of reporting done before their process exits', async t => {
    const value = await fixture(t), owner = value.create(); await owner.start();
    const first = owner.close(), second = owner.close(); assert.equal(first, second);
    await second; assert.notEqual(value.children[0].exitCode ?? value.children[0].signalCode, null);
});

test('a changed lock is preserved and its failure cannot poison another data directory', async t => {
    const value = await fixture(t), owner = value.create(); await owner.start();
    const lock = path.join(value.data, 'appliance.lock'); await fs.writeFile(lock, 'foreign replacement');
    await assert.rejects(owner.close(), /appliance-lock-changed/);
    assert.equal(await fs.readFile(lock, 'utf8'), 'foreign replacement');
    const other = value.create({ dataDirectory: path.join(value.root, 'other-data') }); await other.start(); await other.close();
});

test('different configuration cannot adopt an existing owner', async t => {
    const value = await fixture(t), first = value.create(); await first.start();
    const second = value.create({ ports: { ssh: 22822 } }); await assert.rejects(second.start(), /appliance-in-use/);
    await second.close(); assert.equal(first.status().state, 'running'); assert.equal(value.children.length, 1);
});

test('integrity failure launches nothing and releases owned lock for a corrected retry', async t => {
    const value = await fixture(t), bad = value.create({ integrity: { ...value.config.integrity, qemuSha256: 'a'.repeat(64) } });
    await assert.rejects(bad.start(), /appliance-integrity/); assert.equal(value.calls.length, 0);
    await assert.rejects(fs.stat(path.join(value.data, 'appliance.lock')), { code: 'ENOENT' });
    const good = value.create(); await good.start(); assert.equal(value.children.length, 1);
});

test('missing executable spawn error settles and leaves no lock', async t => {
    const value = await fixture(t, { spawnFailure: true }), owner = value.create();
    await assert.rejects(owner.start(), /appliance-start/); await owner.close();
    await assert.rejects(fs.stat(path.join(value.data, 'appliance.lock')), { code: 'ENOENT' });
});

test('image tool failure preserves foreign disk and does not spawn QEMU', async t => {
    const value = await fixture(t, { imageFailure: true }), owner = value.create();
    await assert.rejects(owner.start(), /appliance-image-tool/); assert.equal(value.children.length, 0);
    assert.equal((await fs.readdir(value.data)).length, 0);
});

test('close while reserving ports prevents any QEMU spawn and releases reservation once', async t => {
    const value = await fixture(t); let released = 0, reached;
    const atReservation = new Promise(resolve => { reached = resolve; }); let continueReservation;
    const held = new Promise(resolve => { continueReservation = resolve; });
    const owner = value.create({ reservePorts: async () => { reached(); await held; return { ports: { ssh: 23001, musicAssistant: 23002, pcm: 23003, soloist: 23004 }, release: async () => { released++; } }; } });
    const starting = owner.start(); const rejected = assert.rejects(starting, /appliance-cancelled/);
    await atReservation; const closing = owner.close(); continueReservation(); await rejected; await closing;
    assert.equal(value.children.length, 0); assert.equal(released, 1);
});

test('unexpected child exit is cleaned and a later start creates a new owned process', async t => {
    const value = await fixture(t), owner = value.create(); const first = await owner.start();
    value.children[0].kill(); await until(async () => owner.status().state === 'stopped'
        && await fs.stat(path.join(value.data, 'appliance.lock')).then(() => false, error => error.code === 'ENOENT'));
    const second = await owner.start(); assert.notEqual(first.pid, second.pid); assert.equal(value.children.length, 2);
    assert.equal(value.calls.filter(call => call.args[0] === 'create').length, 1);
});

test('live foreign lock is never overwritten or used to terminate its process', async t => {
    const value = await fixture(t); await fs.mkdir(value.data);
    const lock = JSON.stringify({ schema: 1, process: process.pid, nonce: 'a'.repeat(48) }); await fs.writeFile(path.join(value.data, 'appliance.lock'), lock);
    const owner = value.create(); await assert.rejects(owner.start(), /appliance-in-use/); assert.equal(value.calls.length, 0);
    assert.equal(await fs.readFile(path.join(value.data, 'appliance.lock'), 'utf8'), lock);
});

test('confirmed dead process lock is recovered without touching personal data', async t => {
    const value = await fixture(t); await fs.mkdir(value.data);
    await fs.writeFile(path.join(value.data, 'appliance.lock'), JSON.stringify({ schema: 1, process: 2147483000, nonce: 'a'.repeat(48) }));
    await fs.writeFile(path.join(value.data, 'paired-user-state'), 'private fixture stays');
    const owner = value.create(); await owner.start(); await owner.close();
    assert.equal(await fs.readFile(path.join(value.data, 'paired-user-state'), 'utf8'), 'private fixture stays');
});

test('occupied requested forward fails without killing or replacing the listener', async t => {
    const value = await fixture(t), listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => listener.close(resolve)));
    const owner = value.create({ ports: { ssh: listener.address().port } });
    await assert.rejects(owner.start(), /appliance-port-unavailable/); assert.equal(value.children.length, 0);
    assert.equal(listener.listening, true);
});

test('real child stdin EPIPE callback/event is contained and bounded fallback terminates only that child', async t => {
    const value = await fixture(t), owner = value.create(); await owner.start();
    // Windows duplicates stdio handles, so closing fd 0 in the fixture does not reliably create EPIPE.
    // Inject the documented callback + error event on its actual ChildProcess stream instead.
    const stdin = value.children[0].stdin;
    stdin.write = (_, callback) => {
        setImmediate(() => { const error = Object.assign(Error('broken pipe fixture'), { code: 'EPIPE' }); callback?.(error); stdin.emit('error', error); });
        return false;
    };
    await owner.close(); assert.equal(owner.status().state, 'closed'); assert.equal(value.children[0].signalCode, 'SIGTERM');
    assert.ok(value.pipeErrors.includes('EPIPE'));
});

test('spawn followed by early QEMU exit cannot return a running lease', async t => {
    const value = await fixture(t); await fs.writeFile(path.join(value.root, 'qmp.cjs'), 'process.exit(1);');
    const owner = value.create(); await assert.rejects(owner.start(), /appliance-start/);
    assert.equal(owner.status().state, 'stopped'); await assert.rejects(fs.stat(path.join(value.data, 'appliance.lock')), { code: 'ENOENT' });
});

test('unresponsive QMP is bounded and its owned child is terminated', async t => {
    const value = await fixture(t); await fs.writeFile(path.join(value.root, 'qmp.cjs'), 'setInterval(()=>{},1000);');
    const owner = value.create({ startTimeoutMs: 60 }); await assert.rejects(owner.start(), /appliance-start-timeout/);
    assert.notEqual(value.children[0].exitCode ?? value.children[0].signalCode, null);
    await assert.rejects(fs.stat(path.join(value.data, 'appliance.lock')), { code: 'ENOENT' });
});

test('bootstrap seed is independently verified and mounted readonly', async t => {
    const value = await fixture(t), seedPath = path.join(value.root, 'seed.iso'), bytes = Buffer.from('public bootstrap seed fixture');
    await fs.writeFile(seedPath, bytes); const owner = value.create({ bootstrapSeed: { path: seedPath, sha256: digest(bytes) } });
    await owner.start(); const args = value.calls.find(call => call.file.endsWith('qemu-system-x86_64.exe')).args;
    assert.ok(args.includes(`file=${seedPath},format=raw,media=cdrom,readonly=on`));
    await owner.close(); assert.deepEqual(await fs.readFile(seedPath), bytes);
    const altered = value.create({ bootstrapSeed: { path: seedPath, sha256: 'b'.repeat(64) } });
    await assert.rejects(altered.start(), /appliance-integrity/); assert.equal(value.children.length, 1);
});

test('only a structurally valid public SSH key can enter firmware arguments', async t => {
    const value = await fixture(t), raw = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]);
    const publicKey = 'ssh-ed25519 ' + bytes.toString('base64'), owner = value.create({ bootstrapSshPublicKey: publicKey });
    await owner.start(); const args = value.calls.find(call => call.file.endsWith('qemu-system-x86_64.exe')).args;
    assert.ok(args.includes('name=opt/folia/ssh-public-key,string=' + publicKey));
    for (const input of ['ssh-ed25519 ' + 'a'.repeat(68), publicKey + '\n', '-----BEGIN PRIVATE KEY-----', publicKey + ',file=C:/secret'])
        assert.throws(() => value.create({ bootstrapSshPublicKey: input }), /appliance-configuration/);
});

test('host identity is independently pinned and only its file path enters QEMU arguments', async t => {
    const value = await fixture(t), raw = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]);
    const publicKey = 'ssh-ed25519 ' + bytes.toString('base64'), privateBytes = Buffer.from('private host identity fixture never passed as argument');
    const hostFile = path.join(value.root, 'host-key'), hostKey = { path: hostFile, sha256: digest(privateBytes), publicKey };
    await fs.writeFile(hostFile, privateBytes, { mode: 0o600 });
    const owner = value.create({ bootstrapSshPublicKey: publicKey, bootstrapSshHostKey: hostKey });
    const lease = await owner.start(), args = value.calls.find(call => call.file.endsWith('qemu-system-x86_64.exe')).args;
    assert.ok(args.includes('name=opt/folia/ssh-host-private-key,file=' + hostFile));
    assert.ok(args.includes('name=opt/folia/ssh-host-public-key,string=' + publicKey));
    assert.ok(!JSON.stringify(args).includes(privateBytes.toString())); assert.ok(!JSON.stringify(lease).includes(hostFile));
    const conflict = value.create({ bootstrapSshPublicKey: publicKey, bootstrapSshHostKey: { ...hostKey, sha256: 'c'.repeat(64) } });
    await assert.rejects(conflict.start(), /appliance-in-use/); await conflict.close(); await owner.close();
    await fs.writeFile(hostFile, 'changed private identity');
    const changed = value.create({ bootstrapSshPublicKey: publicKey, bootstrapSshHostKey: hostKey });
    await assert.rejects(changed.start(), /appliance-integrity/); assert.equal(value.children.length, 1);
    assert.throws(() => value.create({ bootstrapSshHostKey: hostKey }), /appliance-configuration/);
    assert.throws(() => value.create({ bootstrapSshPublicKey: publicKey, bootstrapSshHostKey: { ...hostKey, publicKey: publicKey + ',file=bad' } }), /appliance-configuration/);
});

test('real qemu-img creates and verifies a COW disk against the public pristine Debian base without booting a VM',
    { skip: !process.env.FOLIA_TEST_QEMU_DIRECTORY || !process.env.FOLIA_TEST_PUBLIC_DEBIAN_IMAGE }, async t => {
        const value = await fixture(t), directory = path.resolve(process.env.FOLIA_TEST_QEMU_DIRECTORY), base = path.resolve(process.env.FOLIA_TEST_PUBLIC_DEBIAN_IMAGE);
        assert.equal(path.basename(base), 'debian-13-nocloud-amd64.qcow2');
        const integrity = {
            baseImageSha512: '456f244f66bdfad45be8c1378630effac0ea2a67e826c99c280edb8a40b747b73aa67057fa39130aacd53df82a662683e06238667fd1f15bbda581c02383eb46',
            qemuSha256: digest(await fs.readFile(path.join(directory, 'qemu-system-x86_64.exe'))),
            qemuImgSha256: digest(await fs.readFile(path.join(directory, 'qemu-img.exe'))),
        };
        const spawnProcess = (file, args, flags) => file.endsWith('qemu-img.exe') ? spawn(file, args, flags) : value.config.spawnProcess(file, args, flags);
        const owner = value.create({ runtimeDirectory: directory, baseImage: base, integrity, spawnProcess });
        const lease = await owner.start(); assert.ok((await fs.stat(lease.overlayImage)).size < 1024 * 1024);
        assert.equal(value.children.length, 1); // The only OS child acting as QEMU is the test's Node QMP fixture.
        await owner.close(); assert.equal(value.children[0].exitCode, 0);
    });

test('existing overlay with another backing image is preserved and rejected', async t => {
    const value = await fixture(t), owner = value.create(); await owner.start(); await owner.close();
    const disk = path.join(value.data, 'appliance.qcow2'); const changed = JSON.stringify({ format: 'qcow2', 'full-backing-filename': path.join(value.root, 'other.qcow2'), 'virtual-size': 17179869184 });
    await fs.writeFile(disk, changed); const second = value.create(); await assert.rejects(second.start(), /appliance-overlay-info/);
    assert.equal(await fs.readFile(disk, 'utf8'), changed); assert.equal(value.children.length, 1);
});
