'use strict';
const { TextDecoder } = require('node:util');

// Main-only, bounded OpenSSH failure enums. Never expose raw stderr, paths,
// account names, key material or permission bypasses to callers or diagnostics.
const UNKNOWN = 'APPLIANCE_CHANNEL_UNAVAILABLE';
const codes = Object.freeze([UNKNOWN, 'SSH_CONNECTION_REFUSED', 'SSH_CONNECTION_TIMEOUT', 'SSH_HOST_KEY_REJECTED',
  'SSH_CLIENT_KEY_PERMISSIONS', 'SSH_CLIENT_KEY_UNAVAILABLE', 'SSH_AUTHENTICATION_FAILED', 'SSH_WINDOWS_PERMISSION_DENIED']);
const fail = () => Object.assign(new Error('Spotify SSH: INVALID_REQUEST'), { code: 'INVALID_REQUEST' });

function classifyText(text) {
  const found = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'Host key verification failed.' || /^@*\s*WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\s*@*$/.test(line))
      found.add('SSH_HOST_KEY_REJECTED');
    if (/^(?:@*\s*WARNING: UNPROTECTED PRIVATE KEY FILE!\s*@*|Permissions for ['"][^\r\n]+['"] are too open\.|Bad permissions\. Try removing permissions for user:.*)$/.test(line)
      || /^Load key ['"][^\r\n]+['"]: (?:bad permissions|Permission denied)$/.test(line)) found.add('SSH_CLIENT_KEY_PERMISSIONS');
    if (/^Load key ['"][^\r\n]+['"]: (?:invalid format|error in libcrypto|No such file or directory|incorrect passphrase supplied to decrypt private key)$/.test(line)
      || /^no such identity: [^\r\n]+: No such file or directory$/.test(line)) found.add('SSH_CLIENT_KEY_UNAVAILABLE');
    if (/^(?:[^\s]+@)?127\.0\.0\.1: Permission denied \((?:publickey|password|keyboard-interactive)(?:,(?:publickey|password|keyboard-interactive))*\)\.?$/.test(line))
      found.add('SSH_AUTHENTICATION_FAILED');
    const connection = /^ssh: connect to host (?:127\.0\.0\.1|localhost|::1) port (\d{1,5}): (Connection refused|Connection timed out|Operation timed out|Permission denied)\.?$/.exec(line);
    if (connection && Number(connection[1]) > 0 && Number(connection[1]) <= 65535) {
      found.add(connection[2] === 'Connection refused' ? 'SSH_CONNECTION_REFUSED'
        : connection[2] === 'Permission denied' ? 'SSH_WINDOWS_PERMISSION_DENIED' : 'SSH_CONNECTION_TIMEOUT');
    }
    if (/^(?:CreateProcessW|CreateProcessAsUserW) failed error[: ]+5\.?$/.test(line) || line === 'Access is denied.')
      found.add('SSH_WINDOWS_PERMISSION_DENIED');
  }
  // A rejected client key normally also produces publickey authentication failure.
  // Preserve that more specific cause, but never guess among conflicting failures.
  if (found.has('SSH_AUTHENTICATION_FAILED') && (found.has('SSH_CLIENT_KEY_PERMISSIONS') || found.has('SSH_CLIENT_KEY_UNAVAILABLE')))
    found.delete('SSH_AUTHENTICATION_FAILED');
  return found.size === 1 ? [...found][0] : UNKNOWN;
}

function createSshFailureClassifier({ maxBytes = 4096, maxChunks = 128 } = {}) {
  if (process.type === 'renderer' || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 16384
    || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 1024) throw fail();
  const bytes = Buffer.alloc(maxBytes); let length = 0, chunks = 0, invalid = false, disposed = false;
  return Object.freeze({
    append(chunk) {
      if (disposed || invalid) return false;
      if (!(chunk instanceof Uint8Array) || ++chunks > maxChunks || chunk.byteLength > maxBytes - length) {
        invalid = true; bytes.fill(0); length = 0; return false;
      }
      bytes.set(chunk, length); length += chunk.byteLength; return true;
    },
    classify() {
      if (disposed || invalid || !length) return UNKNOWN;
      try { return classifyText(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { return UNKNOWN; }
    },
    dispose() { disposed = true; bytes.fill(0); length = 0; },
  });
}
module.exports = { createSshFailureClassifier, sshFailureCodes: codes, publicSshFailureCodes: codes };
