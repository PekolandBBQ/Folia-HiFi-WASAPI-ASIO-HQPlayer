const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createWindowsPrivateDirectoryGate } = require('../../electron/spotify/windowsPrivateDirectory.cjs');

// Synthetic filesystem witnesses and owned children; no ACL or key side effects.
const directory = 'C:\\private parent\\.appliance-runtime-abcdef';
const ACK = Buffer.from('{"ok":true,"secured":true,"identityVerified":true}');
function fixture(changes = {}) {
  const calls = [], ioCalls = []; let snapshots = 0, kills = 0;
  const io = {
    async lstat(filename, options) { ioCalls.push(['lstat', filename, options]);
      return { dev: 37n, ino: BigInt(filename.length), isDirectory: () => true, isSymbolicLink: () => false, ...changes.stat?.(filename, snapshots) }; },
    async realpath(filename) { return changes.realpath ? changes.realpath(filename) : filename; },
    async readdir() { snapshots++; return changes.entries || []; },
  };
  const spawnProcess = (executable, args, settings) => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.kill = () => { kills++; };
    child.stdin.end = body => {
      calls.push({ executable, args, settings, body: Buffer.from(body), child });
      if (changes.respond) changes.respond(child);
      else setImmediate(() => { child.stdout.emit('data', ACK); child.emit('close', 0); });
    };
    if (changes.spawnError) throw Error('private path and SID must never escape');
    return child;
  };
  return { gate: createWindowsPrivateDirectoryGate({ io, spawnProcess, platform: 'win32', systemRoot: 'C:\\Windows', ...changes.options }),
    calls, ioCalls, kills: () => kills };
}
test('private directory uses one fixed PowerShell child, bounded identity stdin and held-handle-only ACL mutation', async () => {
  const value = fixture(); assert.deepEqual(await value.gate(directory), { ok: true, secured: true, identityVerified: true });
  assert.equal(value.calls.length, 1); const call = value.calls[0], body = JSON.parse(call.body);
  assert.equal(call.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.settings, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.deepEqual(body.parents.map(item => item.path), ['C:\\', 'C:\\private parent']);
  assert.equal(body.directory, directory); assert.equal(typeof body.inode, 'string'); assert.equal(typeof body.device, 'string');
  const script = Buffer.from(call.args[3], 'base64').toString('utf16le');
  assert.match(script, /CreateFileW\(value,mutate \? 0x000E0080u : 0x80u,3u/);
  assert.match(script, /0x02200000u/); assert.match(script, /SetSecurityInfo\(handle,1,0x80000005u/);
  assert.match(script, /new SecurityIdentifier\(previousOwner\).Value!=sid/);
  assert.match(script, /DiscretionaryAclProtected/); assert.match(script, /AceFlags.ObjectInherit\|AceFlags.ContainerInherit/);
  assert.equal(/Set-Acl|icacls|Get-ChildItem|-ExecutionPolicy|Invoke-Expression/.test(script), false);
  assert.equal(call.args.some(arg => arg.includes(directory)), false);
});
test('private directory rejects unsafe names, traversal, alternate streams and relative paths before filesystem access', async () => {
  for (const name of ['relative\\.appliance-runtime-abcdef', '\\\\server\\share\\.appliance-runtime-abcdef',
    'C:\\parent\\..\\.appliance-runtime-abcdef', 'C:\\parent:stream\\.appliance-runtime-abcdef',
    'C:\\parent.\\.appliance-runtime-abcdef', 'C:\\parent\\ordinary', 'C:\\parent\\.appliance-runtime-short',
    'C:\\parent\\.appliance-runtime-abcdef\n', 'C:\\parent\\.appliance-runtime-abc"def']) {
    const value = fixture(); await assert.rejects(value.gate(name), { code: 'PRIVATE_DIRECTORY_UNSAFE' });
    assert.equal(value.ioCalls.length, 0); assert.equal(value.calls.length, 0);
  }
});
test('private directory refuses linked, non-directory, zero-inode or noncanonical ancestry and nonempty leaf', async () => {
  for (const changes of [{ stat: filename => filename === 'C:\\private parent' ? { isSymbolicLink: () => true } : {} },
    { stat: () => ({ isDirectory: () => false }) }, { stat: () => ({ ino: 0n }) }, { stat: () => ({ dev: -1n }) },
    { realpath: filename => filename === directory ? 'C:\\different\\.appliance-runtime-abcdef' : filename }, { entries: ['untrusted-file'] }]) {
    const value = fixture(changes); await assert.rejects(value.gate(directory), { code: 'PRIVATE_DIRECTORY_UNSAFE' }); assert.equal(value.calls.length, 0);
  }
});
test('private directory notices identity replacement after an otherwise valid native acknowledgement', async () => {
  const value = fixture({ stat: (filename, snapshots) => snapshots && filename === directory ? { ino: 987n } : {} });
  await assert.rejects(value.gate(directory), { code: 'PRIVATE_DIRECTORY_CHANGED' }); assert.equal(value.calls.length, 1);
});
test('private directory accepts only the exact successful acknowledgement and never exposes raw child output', async () => {
  for (const bytes of [Buffer.from('{"ok":true,"secured":true,"identityVerified":true,"key":"SECRET"}'),
    Buffer.from('{"ok":true,"ok":true,"secured":true,"identityVerified":true}'),
    Buffer.from([0xff, 0xfe]), Buffer.alloc(1025, 65), Buffer.from('SECRET path SID')]) {
    const value = fixture({ respond: child => setImmediate(() => { child.stdout.emit('data', bytes); child.emit('close', 0); }) });
    await assert.rejects(value.gate(directory), error => error.code === 'PRIVATE_DIRECTORY_PROTOCOL_INVALID'
      && !error.message.includes('SECRET') && !error.message.includes(directory));
  }
});
test('private directory propagates only declared native failures with a failing exit status', async () => {
  for (const code of ['PRIVATE_DIRECTORY_UNSAFE', 'PRIVATE_DIRECTORY_CHANGED', 'PRIVATE_DIRECTORY_PERMISSION_FAILED']) {
    const value = fixture({ respond: child => setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, code }))); child.emit('close', 1); }) });
    await assert.rejects(value.gate(directory), { code });
  }
  for (const [reply, exitCode] of [[{ ok: false, code: 'PRIVATE_DIRECTORY_CHANGED' }, 0],
    [{ ok: false, code: 'SECRET_CODE' }, 1], [{ ok: true, secured: true, identityVerified: true }, 1]]) {
    const value = fixture({ respond: child => setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(reply))); child.emit('close', exitCode); }) });
    await assert.rejects(value.gate(directory), { code: 'PRIVATE_DIRECTORY_PROTOCOL_INVALID' });
  }
});
test('private directory cancellation before witnessing never spawns or reads the filesystem', async () => {
  const value = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(value.gate(directory, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(value.calls.length, 0); assert.equal(value.ioCalls.length, 0);
});
test('private directory cancellation kills only its own pending child and cannot accept a late acknowledgement', async () => {
  const controller = new AbortController(); let called;
  const started = new Promise(resolve => { called = resolve; });
  const value = fixture({ respond: child => { called(child); } });
  const pending = value.gate(directory, { signal: controller.signal }); const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  const child = await started; controller.abort(); child.stdout.emit('data', ACK); child.emit('close', 0); await rejected;
  assert.equal(value.kills(), 1);
});
test('private directory timeout and process/pipe failures are bounded and safely classified', async () => {
  const stalled = fixture({ respond: () => {}, options: { timeoutMs: 100 } });
  await assert.rejects(stalled.gate(directory), { code: 'PRIVATE_DIRECTORY_CONTROL_TIMEOUT' }); assert.equal(stalled.kills(), 1);
  const failed = fixture({ spawnError: true }); await assert.rejects(failed.gate(directory), { code: 'PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE' });
  for (const emitter of ['child', 'stdin', 'stdout']) {
    const value = fixture({ respond: child => setImmediate(() => (emitter === 'child' ? child : child[emitter]).emit('error', Error('private SID/key/path'))) });
    await assert.rejects(value.gate(directory), error => error.code === 'PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE' && !error.message.includes('SID/key/path'));
  }
});
test('private directory constructor is main-only and rejects unsafe platform or executable configuration', () => {
  for (const options of [{ platform: 'linux' }, { systemRoot: 'powershell.exe' }, { systemRoot: 'C:\\Windows:stream' },
    { timeoutMs: 99 }, { timeoutMs: 30001 }, { spawnProcess: null }]) {
    assert.throws(() => createWindowsPrivateDirectoryGate({ platform: 'win32', ...options }), { code: 'INVALID_REQUEST' });
  }
  const old = process.type;
  try { process.type = 'renderer'; assert.throws(() => createWindowsPrivateDirectoryGate({ platform: 'win32' }), { code: 'INVALID_REQUEST' }); }
  finally { if (old === undefined) delete process.type; else process.type = old; }
});
