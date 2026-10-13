'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSshFailureClassifier, publicSshFailureCodes } = require('../../electron/spotify/sshFailureClassifier.cjs');

// Only synthetic stderr. No executable, real key, profile, SSH or network access.
const classify = text => { const value = createSshFailureClassifier(); value.append(Buffer.from(text)); return value.classify(); };
test('fixed loopback SSH connection failures have separate safe enums', () => {
  for (const [reason, expected] of [['Connection refused', 'SSH_CONNECTION_REFUSED'], ['Connection timed out', 'SSH_CONNECTION_TIMEOUT'],
    ['Operation timed out', 'SSH_CONNECTION_TIMEOUT'], ['Permission denied', 'SSH_WINDOWS_PERMISSION_DENIED']]) {
    assert.equal(classify(`ssh: connect to host 127.0.0.1 port 54321: ${reason}\r\n`), expected);
  }
  assert.equal(classify('ssh: connect to host remote.invalid port 22: Connection refused'), 'APPLIANCE_CHANNEL_UNAVAILABLE');
  assert.equal(classify('ssh: connect to host 127.0.0.1 port 99999: Connection refused'), 'APPLIANCE_CHANNEL_UNAVAILABLE');
});
test('host-key failures remain strict rejection and cannot be confused with connectivity', () => {
  assert.equal(classify('Host key verification failed.\r\n'), 'SSH_HOST_KEY_REJECTED');
  assert.equal(classify('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n'), 'SSH_HOST_KEY_REJECTED');
  assert.equal(classify('Host key verification failed.\nssh: connect to host 127.0.0.1 port 51311: Connection refused\n'), 'APPLIANCE_CHANNEL_UNAVAILABLE');
});
test('client-key load, ACL and authentication failures preserve the specific known cause', () => {
  for (const reason of ['invalid format', 'error in libcrypto', 'No such file or directory', 'incorrect passphrase supplied to decrypt private key'])
    assert.equal(classify(`Load key "C:/private account/client-key": ${reason}`), 'SSH_CLIENT_KEY_UNAVAILABLE');
  assert.equal(classify('no such identity: C:/private account/client-key: No such file or directory'), 'SSH_CLIENT_KEY_UNAVAILABLE');
  for (const text of ['Load key "C:/private/client-key": Permission denied', 'Load key "C:/private/client-key": bad permissions',
    'WARNING: UNPROTECTED PRIVATE KEY FILE!', "Permissions for 'C:/private/client-key' are too open.", 'Bad permissions. Try removing permissions for user: PRIVATE\\OTHER'])
    assert.equal(classify(text), 'SSH_CLIENT_KEY_PERMISSIONS');
  assert.equal(classify('folia@127.0.0.1: Permission denied (publickey).'), 'SSH_AUTHENTICATION_FAILED');
  assert.equal(classify('Load key "C:/private/client-key": invalid format\nfolia@127.0.0.1: Permission denied (publickey).'), 'SSH_CLIENT_KEY_UNAVAILABLE');
  assert.equal(classify('WARNING: UNPROTECTED PRIVATE KEY FILE!\nfolia@127.0.0.1: Permission denied (publickey).'), 'SSH_CLIENT_KEY_PERMISSIONS');
});
test('Windows access-denied diagnostics are enums without path or account material', () => {
  assert.equal(classify('CreateProcessW failed error:5'), 'SSH_WINDOWS_PERMISSION_DENIED');
  assert.equal(classify('CreateProcessAsUserW failed error 5.'), 'SSH_WINDOWS_PERMISSION_DENIED');
  assert.equal(classify('Access is denied.'), 'SSH_WINDOWS_PERMISSION_DENIED');
});
test('sensitive payloads are never returned, logged or stored in exposed fields', () => {
  const secret = 'spak_' + 's'.repeat(40), privatePath = 'C:/Users/Private Account/private-key';
  const value = createSshFailureClassifier(); value.append(Buffer.from(`private=${secret}\nLoad key "${privatePath}": invalid format\n`));
  const result = value.classify(); assert.equal(result, 'SSH_CLIENT_KEY_UNAVAILABLE');
  assert.ok(publicSshFailureCodes.includes(result)); assert.equal(JSON.stringify(value), '{}');
  assert.equal(result.includes(secret), false); assert.equal(result.includes(privatePath), false);
  value.dispose(); assert.equal(value.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
});
test('chunk boundaries, CRLF and split UTF-8 cannot change the safe classification', () => {
  const bytes = Buffer.from('路径私密\r\nssh: connect to host 127.0.0.1 port 51311: Connection refused\r\n');
  for (let at = 1; at < bytes.length; at++) {
    const value = createSshFailureClassifier(); assert.equal(value.append(bytes.subarray(0, at)), true);
    assert.equal(value.append(bytes.subarray(at)), true); assert.equal(value.classify(), 'SSH_CONNECTION_REFUSED'); value.dispose();
  }
});
test('byte or chunk overflow, invalid UTF-8 and wrong data types remain unknown and bounded', () => {
  const oversized = createSshFailureClassifier({ maxBytes: 256 }); oversized.append(Buffer.from('Host key verification failed.\n'));
  assert.equal(oversized.append(Buffer.alloc(257)), false); assert.equal(oversized.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
  assert.equal(oversized.append(Buffer.from('Access is denied.')), false);
  const many = createSshFailureClassifier({ maxChunks: 1 }); many.append(Buffer.from('Host key verification failed.'));
  assert.equal(many.append(Buffer.alloc(0)), false); assert.equal(many.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
  const malformed = createSshFailureClassifier(); malformed.append(Buffer.from([0xff])); malformed.append(Buffer.from('Access is denied.'));
  assert.equal(malformed.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
  const wrong = createSshFailureClassifier(); assert.equal(wrong.append('Host key verification failed.'), false);
  assert.equal(wrong.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
});
test('unknown text, misleading embedded phrases and disposed collectors never invent a cause', () => {
  for (const text of ['', 'unclassified private payload', 'secret=Host key verification failed.', 'Permission denied',
    'ssh: unknown-host - Connection refused', 'private=WARNING: UNPROTECTED PRIVATE KEY FILE!'])
    assert.equal(classify(text), 'APPLIANCE_CHANNEL_UNAVAILABLE');
  const value = createSshFailureClassifier(); value.dispose(); assert.equal(value.append(Buffer.from('Access is denied.')), false);
  assert.equal(value.classify(), 'APPLIANCE_CHANNEL_UNAVAILABLE');
});
test('renderer and malformed main configuration are rejected without leaking values', () => {
  for (const options of [{ maxBytes: 1 }, { maxBytes: 16385 }, { maxBytes: true }, { maxChunks: 0 }, { maxChunks: 1025 }])
    assert.throws(() => createSshFailureClassifier(options), { code: 'INVALID_REQUEST' });
  const previous = process.type; try { process.type = 'renderer'; assert.throws(() => createSshFailureClassifier(), { code: 'INVALID_REQUEST' }); }
  finally { if (previous === undefined) delete process.type; else process.type = previous; }
});
