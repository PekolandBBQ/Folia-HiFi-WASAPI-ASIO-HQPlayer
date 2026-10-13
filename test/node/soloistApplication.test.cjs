'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { createApplicationSoloist, readComponent } = require('../../electron/spotify/soloistApplication.cjs');

// test/node/soloistApplication.test.cjs: public synthetic components only; no
// actual account, SSH child, appliance boot or installed application is used.
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const sourcePath = require.resolve('../../electron/spotify/soloistApplication.cjs');
const storage = () => ({ isEncryptionAvailable: () => true,
  encryptString: () => { throw Error('No credential write is part of these tests'); },
  decryptString: () => { throw Error('No existing credential is part of these tests'); } });

function fixture(t, { releaseReady = false, baseBytes = Buffer.from('Synthetic clean disk, without accounts') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-application-test-'));
  const component = path.join(root, 'spotify-soloist-appliance'), originals = new Map(); fs.mkdirSync(component);
  const write = (relative, bytes) => { const file = path.join(component, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes); return file; };
  for (const relative of ['qemu/qemu-system-x86_64.exe', 'qemu/qemu-img.exe', 'qemu/libstdc++-6.dll',
    'qemu/share/QEMU,cgthree.bin', 'qemu/share/bios-256k.bin', 'ssh/ssh.exe', 'ssh/libcrypto.dll', 'ssh/ssh-keygen.exe']) {
    const bytes = Buffer.from('Public synthetic fixture: ' + relative); originals.set(relative, bytes); write(relative, bytes);
  }
  write('folia-soloist-clean-base.qcow2', baseBytes); write('LICENSE.txt', 'Public license fixture');
  write('sources.json', '{"public":true}');
  const manifest = { schema: 1, id: 'folia-spotify-soloist-qemu', platform: 'win32', arch: 'x64', releaseReady,
    soloist: { bundled: false, perUserOfficialDownload: true }, owner: { runtimeDirectory: 'qemu', baseImage: 'folia-soloist-clean-base.qcow2',
      integrity: { baseImageSha512: hash(baseBytes, 'sha512'), qemuSha256: hash(originals.get('qemu/qemu-system-x86_64.exe')),
        qemuImgSha256: hash(originals.get('qemu/qemu-img.exe')) } },
    runtimeFiles: Object.fromEntries([...originals].map(([relative, bytes]) => [relative, hash(bytes)])) };
  const manifestPath = path.join(component, 'component.manifest.json'); let pin;
  const save = bytes => { const output = bytes || Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(manifestPath, output); pin = hash(output); return pin; };
  save();
  t.after(() => { const target = path.resolve(root), allowed = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target).toLowerCase(), allowed.toLowerCase()); assert.ok(path.basename(target).startsWith('folia-application-test-'));
    fs.rmSync(target, { recursive: true, force: true }); });
  return { root, component, manifest, manifestPath, originals, write, save,
    read: (changes = {}) => readComponent({ directory: component, manifestSha256: pin, packaged: false, ...changes }),
    environment: () => ({ FOLIA_SOLOIST_COMPONENT_DIRECTORY: component, FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256: pin }) };
}

function assembly(t, options = {}) {
  const value = fixture(t, options), environment = value.environment(), calls = [], settings = []; let closes = 0;
  const channel = { sshPort: 51101, pcmPort: 51103, user: 'folia' }, snapshot = { fixture: 'fresh owned observation' };
  const config = { ownedSoloist: {
    readFresh: request => { calls.push(['fresh', request]); return Promise.resolve(snapshot); },
    seekOwnedPaused: (request, control) => { calls.push(['seek', request, control]); return Promise.resolve({ acknowledged: true }); },
    markCodecDiagnostics: (request, control) => { calls.push(['codec-mark', request, control]); return Promise.resolve({ marker: { offset: 0 } }); },
    readCodecDiagnosticsSince: (request, control) => { calls.push(['codec-read', request, control]); return Promise.resolve({ sourceQuality: null, sourceBitDepth: null }); } },
    resolveControlConfiguration: request => { calls.push(['channel', request]); return Promise.resolve(channel); },
    applyQuality: (quality, request) => { calls.push(['quality', quality, request]); return Promise.resolve({ requestedQuality: quality }); } };
  const app = { isPackaged: false, getPath: name => { assert.equal(name, 'userData'); return path.join(value.root, 'private user space'); } };
  const createComposition = value => { settings.push(value); return {
    getSoloistConfiguration: () => config, publicStatus: async () => ({ hasKey: false, state: 'stopped' }),
    startSetup: request => { calls.push(['setup', request]); return Promise.resolve({ state: 'pairing-required' }); },
    stopSetup: () => { calls.push(['stop']); }, logout: () => { calls.push(['logout']); }, close: async () => { closes++; } }; };
  const application = createApplicationSoloist({ app, safeStorage: storage(), environment, createComposition });
  return { ...value, application, environment, settings, calls, config, channel, snapshot, app, createComposition, closes: () => closes };
}

// Compile the unchanged public entry with only its build-time approval require
// replaced. This tests packaged behavior without creating a real approval file.
function approvedEntry(manifestSha256) {
  const isolated = new Module(sourcePath, module); isolated.filename = sourcePath;
  const normal = isolated.require.bind(isolated);
  isolated.require = name => name === './soloist-appliance-approved.json' ? { manifestSha256 } : normal(name);
  isolated._compile(fs.readFileSync(sourcePath, 'utf8'), sourcePath); return isolated.exports;
}
function processProperty(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, { value, configurable: true, writable: true });
  t.after(() => { if (before) Object.defineProperty(process, name, before); else delete process[name]; });
}

test('approved public component covers QEMU EXEs, DLLs, firmware and portable OpenSSH dependencies', t => {
  const value = fixture(t), component = value.read();
  assert.equal(component.ownerOptions.runtimeDirectory, path.join(value.component, 'qemu'));
  assert.equal(component.ownerOptions.baseImage, path.join(value.component, 'folia-soloist-clean-base.qcow2'));
  assert.equal(component.sshExecutablePath, path.join(value.component, 'ssh', 'ssh.exe'));
  assert.equal(component.sshExecutableSha256, value.manifest.runtimeFiles['ssh/ssh.exe']);
  assert.deepEqual(component.ownerOptions.integrity, value.manifest.owner.integrity);
  assert.equal(Object.isFrozen(component.ownerOptions.integrity), true);
});

test('external approval hash is mandatory and internal/self-reported hashes cannot replace it', t => {
  const value = fixture(t); value.manifest.manifestSha256 = 'a'.repeat(64); value.save();
  for (const pin of [undefined, null, '', 123, 'A'.repeat(64), 'a'.repeat(63)])
    assert.throws(() => value.read({ manifestSha256: pin }), { code: 'APPLIANCE_COMPONENT_UNAVAILABLE' });
  assert.throws(() => value.read({ manifestSha256: 'a'.repeat(64) }), { code: 'APPLIANCE_COMPONENT_CHANGED' });
  assert.ok(value.read());
});
test('codec diagnostics capability is externally pinned, strictly typed and disabled for legacy manifests', async t => {
  const value = assembly(t);
  assert.equal(value.read().codecDiagnostics, false);
  for (const capability of [null, [], {}, { codecDiagnostics: 'true' }, { codecDiagnostics: 1 }, { codecDiagnostics: true, other: true }]) {
    value.manifest.capabilities = capability; value.save();
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
  }
  value.manifest.capabilities = { codecDiagnostics: true }; value.environment.FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256 = value.save();
  assert.equal(value.read().codecDiagnostics, true);
  await value.application.startSetup(); assert.equal(value.settings[0].diagnostics, true);
});

test('hash corruption in every executable, DLL, firmware, portable SSH and clean disk is rejected', t => {
  const value = fixture(t);
  for (const [relative, bytes] of [...value.originals, ['folia-soloist-clean-base.qcow2', Buffer.from('Synthetic clean disk, without accounts')]]) {
    value.write(relative, Buffer.from('Corrupted public fixture'));
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_CHANGED' }, relative);
    value.write(relative, bytes);
  }
  assert.ok(value.read());
});

test('runtimeFiles must exactly cover both complete runtime trees, including unknown newly added dependencies', t => {
  const value = fixture(t);
  for (const relative of ['qemu/unapproved.dll', 'qemu/unapproved.exe', 'qemu/share/unapproved.rom', 'ssh/unapproved.dll', 'ssh/unapproved.exe']) {
    const file = value.write(relative, Buffer.from('Not externally approved'));
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' }, relative); fs.unlinkSync(file);
  }
  const removed = value.manifest.runtimeFiles['qemu/libstdc++-6.dll']; delete value.manifest.runtimeFiles['qemu/libstdc++-6.dll']; value.save();
  assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
  value.manifest.runtimeFiles['qemu/libstdc++-6.dll'] = removed; value.save(); assert.ok(value.read());
});

test('component root cannot carry extra executables, DLLs, archives or an undeclared runtime tree', t => {
  const value = fixture(t);
  for (const relative of ['unapproved.exe', 'unapproved.dll', 'soloist_release.tar.gz', 'outside/loader.dll']) {
    const file = value.write(relative, 'Unapproved public fixture');
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' }); fs.unlinkSync(file);
    if (relative.includes('/')) fs.rmdirSync(path.dirname(file));
  }
  assert.ok(value.read());
});

test('portable SSH cannot fall back to PATH or Windows system SSH when its own EXE is absent', t => {
  const value = fixture(t); fs.unlinkSync(path.join(value.component, 'ssh', 'ssh.exe')); delete value.manifest.runtimeFiles['ssh/ssh.exe']; value.save();
  assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
});

test('manifest entries reject traversal, absolute paths, backslashes, ADS, Windows aliases and directories', t => {
  const value = fixture(t), key = 'qemu/libstdc++-6.dll', expected = value.manifest.runtimeFiles[key]; delete value.manifest.runtimeFiles[key];
  for (const unsafe of ['../escape.dll', '/escape.dll', 'C:/escape.dll', 'qemu/../escape.dll', 'qemu\\escape.dll',
    'qemu/escape.dll:payload', 'qemu/escape.dll.', 'qemu/escape.dll ', 'qemu/NUL.dll', 'qemu/./libstdc++-6.dll',
    'QEMU/libstdc++-6.dll', 'qemu/share', 'qemu/escape\u0001.dll']) {
    value.manifest.runtimeFiles[unsafe] = expected; value.save();
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' }, unsafe); delete value.manifest.runtimeFiles[unsafe];
  }
});

test('a real directory junction to a sibling with a matching lexical prefix cannot escape containment', t => {
  const value = fixture(t), outside = value.component + '-outside'; fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'payload.dll'), 'Outside fixture');
  fs.symlinkSync(outside, path.join(value.component, 'qemu', 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  value.manifest.runtimeFiles['qemu/outside/payload.dll'] = hash('Outside fixture'); value.save();
  assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
});

test('hard-linked manifest or runtime dependencies are rejected even when their bytes match', t => {
  const value = fixture(t), target = path.join(value.component, 'qemu', 'libstdc++-6.dll'), linked = path.join(value.root, 'external-linked.dll');
  fs.linkSync(target, linked); assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' }); fs.unlinkSync(linked);
  fs.linkSync(value.manifestPath, path.join(value.root, 'external-manifest.json'));
  assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
});

test('manifest parsing is bounded, rejects duplicate keys, invalid UTF-8 and non-object JSON', t => {
  const value = fixture(t), valid = JSON.stringify(value.manifest);
  const invalidUtf8 = Buffer.concat([Buffer.from(valid.slice(0, -1) + ',"description":"'), Buffer.from([255]), Buffer.from('"}')]);
  for (const bytes of [Buffer.from(valid.replace('"schema":1', '"schema":1,"schema":1')), invalidUtf8,
    Buffer.from('null'), Buffer.from('[]'), Buffer.alloc(2 * 1024 * 1024 + 1, 32)]) {
    value.save(bytes); assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' });
  }
});

test('manifest growth after its size check is rejected without buffering the newly added bytes', t => {
  const value = fixture(t), inode = fs.statSync(value.manifestPath).ino, read = fs.readSync; let grew = false, maximum = 0;
  fs.readSync = function(fd, buffer, ...args) { maximum = Math.max(maximum, buffer.length); const count = read.call(this, fd, buffer, ...args);
    if (fs.fstatSync(fd).ino === inode && !grew) { grew = true; fs.appendFileSync(value.manifestPath, Buffer.alloc(3 * 1024 * 1024)); }
    return count; };
  try { assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_CHANGED' }); assert.equal(grew, true); assert.ok(maximum < 16384); }
  finally { fs.readSync = read; }
});

test('dependency additions or replacement after a successful file hash cannot escape the final inventory check', t => {
  const value = fixture(t), disk = path.join(value.component, 'folia-soloist-clean-base.qcow2'), inode = fs.statSync(disk).ino, read = fs.readSync;
  for (const replacement of [false, true]) {
    let changed = false;
    fs.readSync = function(fd, ...args) { const count = read.call(this, fd, ...args);
      if (fs.fstatSync(fd).ino === inode && !changed) { changed = true;
        if (replacement) value.write('qemu/libstdc++-6.dll', 'Changed after DLL hash');
        else value.write('qemu/late-unapproved.dll', 'Added after initial inventory'); }
      return count; };
    try { assert.throws(() => value.read(), error => error.code === 'APPLIANCE_COMPONENT_CHANGED' || error.code === 'APPLIANCE_COMPONENT_INVALID');
      assert.equal(changed, true); }
    finally { fs.readSync = read; }
    if (!replacement) fs.unlinkSync(path.join(value.component, 'qemu', 'late-unapproved.dll'));
  }
});

test('component architecture, per-user official download and owner integrity contract cannot be relaxed', t => {
  const value = fixture(t), original = JSON.stringify(value.manifest);
  const invalid = [m => { m.schema = 2; }, m => { m.id = 'another-appliance'; }, m => { m.platform = 'linux'; }, m => { m.arch = 'arm64'; },
    m => { m.releaseReady = 'true'; }, m => { m.soloist.bundled = true; }, m => { m.soloist.perUserOfficialDownload = false; },
    m => { m.owner.runtimeDirectory = 'elsewhere'; }, m => { m.owner.baseImage = '../paired-user.qcow2'; },
    m => { m.owner.integrity.baseImageSha512 = 'a'.repeat(64); }, m => { m.owner.integrity.qemuSha256 = 'a'.repeat(64); },
    m => { m.runtimeFiles['ssh/ssh.exe'] = 3; }];
  for (const change of invalid) { const m = JSON.parse(original); change(m); value.save(Buffer.from(JSON.stringify(m)));
    assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_INVALID' }); }
});

test('large disk hashes use bounded reads and detect replacement with identical bytes during hashing', t => {
  const value = fixture(t, { baseBytes: Buffer.alloc(3 * 1024 * 1024 + 7, 45) });
  const readFile = fs.readFileSync, read = fs.readSync, disk = path.join(value.component, 'folia-soloist-clean-base.qcow2'); let diskChunks = 0;
  fs.readFileSync = function(file, ...args) { assert.notEqual(file, disk, 'The full disk must never be buffered'); return readFile.call(this, file, ...args); };
  fs.readSync = function(fd, buffer, ...args) { assert.ok(buffer.length <= 1024 * 1024); const count = read.call(this, fd, buffer, ...args);
    if (fs.fstatSync(fd).ino === fs.statSync(disk).ino && count) diskChunks++; return count; };
  try { assert.ok(value.read()); assert.equal(diskChunks, 4); } finally { fs.readFileSync = readFile; fs.readSync = read; }
  const target = path.join(value.component, 'qemu', 'qemu-system-x86_64.exe'), inode = fs.statSync(target).ino; let replaced = false;
  fs.readSync = function(fd, ...args) { const count = read.call(this, fd, ...args);
    if (!count && fs.fstatSync(fd).ino === inode && !replaced) { replaced = true; fs.renameSync(target, target + '.previous');
      fs.writeFileSync(target, value.originals.get('qemu/qemu-system-x86_64.exe')); } return count; };
  try { assert.throws(() => value.read(), { code: 'APPLIANCE_COMPONENT_CHANGED' }); assert.equal(replaced, true); }
  finally { fs.readSync = read; }
});

test('constructor and repeated catalog configuration do zero component/vault I/O or composition assembly', t => {
  const value = fixture(t), app = { isPackaged: false, getPath: () => path.join(value.root, 'unused private') };
  const intercepted = [], methods = ['readFileSync', 'realpathSync', 'lstatSync', 'statSync', 'readdirSync', 'openSync'];
  const promises = ['lstat', 'readFile', 'mkdir']; let compositions = 0;
  for (const name of methods) { const original = fs[name]; intercepted.push([fs, name, original]); fs[name] = () => { throw Error('Unexpected fs.' + name); }; }
  for (const name of promises) { const original = fs.promises[name]; intercepted.push([fs.promises, name, original]); fs.promises[name] = () => { throw Error('Unexpected fs.promises.' + name); }; }
  try {
    const application = createApplicationSoloist({ app, safeStorage: storage(), environment: value.environment(),
      createComposition: () => { compositions++; throw Error('Catalog must not create composition'); } });
    assert.equal(application.getSoloistConfiguration(), application.getSoloistConfiguration());
    assert.equal(application.getSoloistConfiguration().deviceName, 'Folia Spotify'); assert.equal(compositions, 0);
    assert.equal(application.stopSetup(), undefined); assert.equal(application.logout(), undefined);
  } finally { for (const [object, name, original] of intercepted) object[name] = original; }
});

test('all formal lazy entry points reuse one composition and forward request cancellation and control arguments', async t => {
  const value = assembly(t), configuration = value.application.getSoloistConfiguration(), control = { signal: new AbortController().signal };
  const request = { uri: 'spotify:track:' + 'A'.repeat(22), positionMs: 1000 };
  const [fresh, channel, quality] = await Promise.all([configuration.ownedSoloist.readFresh(control),
    configuration.resolveControlConfiguration(control), configuration.applyQuality('lossless', control)]);
  assert.equal(fresh, value.snapshot); assert.equal(channel, value.channel); assert.deepEqual(quality, { requestedQuality: 'lossless' });
  await configuration.ownedSoloist.seekOwnedPaused(request, control); await value.application.startSetup(control);
  assert.equal(value.settings.length, 1); assert.deepEqual(value.calls.map(call => call[0]), ['fresh', 'channel', 'quality', 'seek', 'setup']);
  assert.equal(value.calls[0][1], control); assert.equal(value.calls[3][1], request); assert.equal(value.calls[3][2], control);
  const settings = value.settings[0]; assert.equal(settings.directory, path.join(value.root, 'private user space', 'spotify', 'soloist-appliance'));
  assert.equal(settings.ownerOptions.dataDirectory, path.join(settings.directory, 'appliance-data'));
  assert.equal(settings.sshExecutablePath, path.join(value.component, 'ssh', 'ssh.exe'));
  assert.equal(typeof settings.downloadOfficialAsset, 'function');
  await value.application.stopSetup(); await value.application.logout(); await value.application.close(); assert.equal(value.closes(), 1);
});
test('main-only codec methods share the normal lazy composition and forward the complete lease-bound marker', async t => {
  const value = assembly(t), owned = value.application.getSoloistConfiguration().ownedSoloist;
  const control = { signal: new AbortController().signal }, markRequest = { requestedQuality: 'lossless' };
  const readRequest = { marker: { offset: 0, appliance: { pid: 500, startedAt: 'fixture', ports: { pcm: 51103 } } },
    expectedUri: 'spotify:track:' + 'A'.repeat(22) };
  await owned.markCodecDiagnostics(markRequest, control); const result = await owned.readCodecDiagnosticsSince(readRequest, control);
  assert.equal(value.settings.length, 1); assert.equal(value.settings[0].diagnostics, false);
  assert.deepEqual(value.calls, [['codec-mark', markRequest, control], ['codec-read', readRequest, control]]);
  assert.deepEqual(result, { sourceQuality: null, sourceBitDepth: null });
});

test('a pre-cancelled request or closed application cannot read a component or create a late owner', async t => {
  const value = assembly(t), configuration = value.application.getSoloistConfiguration(), abort = new AbortController(); abort.abort();
  for (const action of [() => configuration.ownedSoloist.readFresh({ signal: abort.signal }),
    () => configuration.applyQuality('high', { signal: abort.signal }), () => value.application.startSetup({ signal: abort.signal })])
    assert.throws(action, { code: 'CANCELLED' });
  assert.equal(value.settings.length, 0); await configuration.resolveControlConfiguration();
  await value.application.close(); assert.throws(() => value.settings[0].createOwner(value.settings[0].ownerOptions), { code: 'APPLIANCE_CLOSED' });
  assert.throws(() => value.application.getSoloistConfiguration(), { code: 'APPLIANCE_CLOSED' });
  assert.throws(() => configuration.ownedSoloist.readFresh(), { code: 'APPLIANCE_CLOSED' });
});

test('adding a DLL after catalog assembly is rejected immediately before lazy owner construction', async t => {
  const value = assembly(t); await value.application.startSetup(); const settings = value.settings[0];
  const ownerOptions = { ...settings.ownerOptions, platform: 'win32' };
  const owner = settings.createOwner(ownerOptions); assert.equal(owner.status().state, 'stopped'); await owner.close();
  value.write('qemu/late-injected.dll', 'Unexpected loader dependency');
  assert.throws(() => settings.createOwner(ownerOptions), { code: 'APPLIANCE_COMPONENT_INVALID' });
});

test('a cached component cannot be re-approved through a changed environment pin', async t => {
  const value = assembly(t); await value.application.startSetup();
  value.environment.FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256 = 'a'.repeat(64);
  assert.throws(() => value.settings[0].createOwner(value.settings[0].ownerOptions), { code: 'APPLIANCE_COMPONENT_CHANGED' });
});

test('failed component verification records a safe failure and allows an explicit corrected retry', async t => {
  const value = assembly(t), relative = 'ssh/libcrypto.dll'; value.write(relative, 'Corrupted dependency');
  assert.throws(() => value.application.startSetup(), { code: 'APPLIANCE_COMPONENT_CHANGED' }); assert.equal(value.settings.length, 0);
  assert.deepEqual(await value.application.publicStatus(), { hasKey: false, state: 'failed', code: 'APPLIANCE_COMPONENT_CHANGED' });
  value.write(relative, value.originals.get(relative)); assert.deepEqual(await value.application.startSetup(), { state: 'pairing-required' });
  assert.equal(value.settings.length, 1);
});

test('packaged assembly ignores developer component overrides and only accepts a separately approved releaseReady component', async t => {
  const value = assembly(t, { releaseReady: true }), entry = approvedEntry(value.environment.FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256);
  processProperty(t, 'resourcesPath', value.root);
  const application = entry.createApplicationSoloist({ app: { ...value.app, isPackaged: true }, safeStorage: storage(),
    environment: { FOLIA_SOLOIST_COMPONENT_DIRECTORY: path.join(value.root, 'nonexistent developer override'),
      FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256: 'a'.repeat(64) }, createComposition: value.createComposition });
  await application.startSetup(); assert.equal(value.settings.length, 1);
  assert.equal(value.settings[0].ownerOptions.runtimeDirectory, path.join(value.component, 'qemu'));
  const unavailable = approvedEntry(undefined).createApplicationSoloist({ app: { ...value.app, isPackaged: true }, safeStorage: storage(),
    environment: value.environment, createComposition: value.createComposition });
  assert.throws(() => unavailable.startSetup(), { code: 'APPLIANCE_COMPONENT_UNAVAILABLE' }); assert.equal(value.settings.length, 1);
});

test('preview components remain usable for isolated development but cannot enter a packaged release even with a valid pin', t => {
  const value = fixture(t); assert.ok(value.read()); assert.throws(() => value.read({ packaged: true }), { code: 'APPLIANCE_COMPONENT_INVALID' });
  processProperty(t, 'resourcesPath', value.root); let compositions = 0;
  const entry = approvedEntry(value.environment().FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256);
  const application = entry.createApplicationSoloist({ app: { isPackaged: true, getPath: () => path.join(value.root, 'unused user') }, safeStorage: storage(),
    createComposition: () => { compositions++; } });
  assert.throws(() => application.startSetup(), { code: 'APPLIANCE_COMPONENT_INVALID' }); assert.equal(compositions, 0);
});

test('renderer cannot resolve a component or construct the main-only application', t => {
  const value = fixture(t); processProperty(t, 'type', 'renderer');
  assert.throws(() => value.read(), { code: 'INVALID_REQUEST' });
  assert.throws(() => createApplicationSoloist({ app: { getPath: () => { throw Error('No renderer paths'); } }, safeStorage: storage() }), { code: 'INVALID_REQUEST' });
});
