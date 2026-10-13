'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const fail = code => Object.assign(new Error(`Spotify appliance: ${code}`), { code });
const KEY = /^spak_[A-Za-z0-9]{20,128}$/;
const names = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).sort().join(',') === expected;
const string = bytes => { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };
const publicBlob = raw => Buffer.concat([string(Buffer.from('ssh-ed25519')), string(raw)]);
function createSshIdentity() {
  const { privateKey } = generateKeyPairSync('ed25519'); const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url'), raw = Buffer.from(jwk.x, 'base64url'), publicBytes = publicBlob(raw);
  const check = randomBytes(4), comment = Buffer.from('Folia owned appliance');
  let block = Buffer.concat([check, check, string(Buffer.from('ssh-ed25519')), string(raw), string(Buffer.concat([seed, raw])), string(comment)]);
  const padding = Buffer.from(Array.from({ length: 8 - block.length % 8 }, (_, i) => i + 1));
  const count = Buffer.from([0, 0, 0, 1]);
  const binary = Buffer.concat([Buffer.from('openssh-key-v1\0'), string(Buffer.from('none')), string(Buffer.from('none')),
    string(Buffer.alloc(0)), count, string(publicBytes), string(Buffer.concat([block, padding]))]);
  try {
    const base64 = binary.toString('base64').match(/.{1,70}/g).join('\n');
    return { publicKey: 'ssh-ed25519 ' + publicBytes.toString('base64'),
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + base64 + '\n-----END OPENSSH PRIVATE KEY-----\n' };
  } finally { seed.fill(0); block.fill(0); binary.fill(0); }
}
function validIdentity(value) {
  if (!names(value, 'privateKey,publicKey') || typeof value.publicKey !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value.publicKey)
    || typeof value.privateKey !== 'string' || value.privateKey.length > 8192) return false;
  let privateBytes, seed;
  try {
    const match = /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END OPENSSH PRIVATE KEY-----\n$/.exec(value.privateKey);
    if (!match) return false; privateBytes = Buffer.from(match[1].replace(/\n/g, ''), 'base64');
    let at = 15; if (privateBytes.subarray(0, at).toString() !== 'openssh-key-v1\0') return false;
    const read = () => { const size = privateBytes.readUInt32BE(at); at += 4; if (size > 8192 || at + size > privateBytes.length) throw Error();
      const result = privateBytes.subarray(at, at + size); at += size; return result; };
    if (read().toString() !== 'none' || read().toString() !== 'none' || read().length !== 0 || privateBytes.readUInt32BE(at) !== 1) return false;
    at += 4; const publicBytes = read(), block = read(); if (at !== privateBytes.length || block.length % 8 !== 0) return false;
    if ('ssh-ed25519 ' + publicBytes.toString('base64') !== value.publicKey || block.readUInt32BE(0) !== block.readUInt32BE(4)) return false;
    let cursor = 8;
    const part = () => { const size = block.readUInt32BE(cursor); cursor += 4; if (size > 8192 || cursor + size > block.length) throw Error();
      const result = block.subarray(cursor, cursor + size); cursor += size; return result; };
    if (part().toString() !== 'ssh-ed25519') return false; const raw = part(), privateRaw = part(); part();
    if (raw.length !== 32 || privateRaw.length !== 64 || !raw.equals(privateRaw.subarray(32)) || !publicBlob(raw).equals(publicBytes)) return false;
    const padding = block.subarray(cursor); if (!padding.length || padding.length > 8 || !padding.every((byte, i) => byte === i + 1)) return false;
    seed = Buffer.from(privateRaw.subarray(0, 32));
    const key = createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url'), d: seed.toString('base64url') } });
    const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } });
    return verify(null, Buffer.from('Folia identity validation'), publicKey, sign(null, Buffer.from('Folia identity validation'), key));
  } catch { return false; } finally { privateBytes?.fill(0); seed?.fill(0); }
}
function validStored(value) {
  return names(value, 'clientIdentity,hostIdentity,maPassword,schema,soloistKey') && value.schema === 1 && KEY.test(value.soloistKey)
    && /^[A-Za-z0-9_-]{24,128}$/.test(value.maPassword) && validIdentity(value.clientIdentity) && validIdentity(value.hostIdentity)
    && value.clientIdentity.publicKey !== value.hostIdentity.publicKey;
}
async function validateDirectory(directory, io, create) {
  const root = path.parse(path.resolve(directory)).root; let current = root;
  for (const part of path.resolve(directory).slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let info;
    try { info = await io.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await io.mkdir(current, { mode: 0o700 }); info = await io.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('SECRET_DIRECTORY_UNSAFE');
  }
  const info = await io.stat(directory);
  if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || info.mode & 0o077)) throw fail('SECRET_DIRECTORY_UNSAFE');
}
async function ensurePrivateDirectory(directory, io = fs) { await validateDirectory(directory, io, true); }
function createSoloistApplianceSecrets({ directory, safeStorage, io = fs } = {}) {
  if (process.type === 'renderer' || typeof directory !== 'string' || !path.isAbsolute(directory) || /[\r\n\0]/.test(directory)
    || !['isEncryptionAvailable', 'encryptString', 'decryptString'].every(key => typeof safeStorage?.[key] === 'function')) throw fail('INVALID_REQUEST');
  const file = path.join(directory, 'appliance-secrets.enc'); let writes = Promise.resolve();
  const enqueue = work => { const task = writes.catch(() => {}).then(work); writes = task; return task; };
  const encryption = () => { if (!safeStorage.isEncryptionAvailable()) throw fail('SECRET_ENCRYPTION_REQUIRED'); };
  async function read() {
    encryption();
    try {
      await validateDirectory(directory, io, false);
      const info = await io.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536
        || typeof process.getuid === 'function' && (info.uid !== process.getuid() || info.mode & 0o077)) throw fail('SECRET_VAULT_INVALID');
      const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const bytes = Buffer.alloc(65537);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) throw fail('SECRET_VAULT_INVALID');
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
        if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== before.mtimeMs) throw fail('SECRET_VAULT_INVALID');
        const value = JSON.parse(safeStorage.decryptString(bytes.subarray(0, bytesRead)));
        if (!validStored(value)) throw fail('SECRET_VAULT_INVALID'); return value;
      } finally { bytes.fill(0); await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail(error.code === 'SECRET_ENCRYPTION_REQUIRED' ? error.code : 'SECRET_VAULT_INVALID'); }
  }
  async function save(value) {
    encryption(); await ensurePrivateDirectory(directory, io);
    const temporary = path.join(directory, '.appliance-secrets-' + randomBytes(12).toString('hex'));
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(JSON.stringify(value)); if (!Buffer.isBuffer(encrypted) || encrypted.length > 65536) throw Error();
      await io.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      // Never replace an existing symlink or an unrelated/invalid vault.
      await read(); await io.rename(temporary, file);
    } catch (error) { throw fail(error.code?.startsWith('SECRET_') ? error.code : 'SECRET_VAULT_WRITE_FAILED'); }
    finally { encrypted?.fill(0); await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw fail('SECRET_VAULT_WRITE_FAILED'); }); }
  }
  return Object.freeze({
    saveKey(key) {
      if (typeof key !== 'string' || !KEY.test(key)) return Promise.reject(fail('SOLOIST_KEY_INVALID'));
      return enqueue(async () => {
        const previous = await read();
        const value = previous || { schema: 1, soloistKey: key, maPassword: randomBytes(32).toString('base64url'),
          clientIdentity: createSshIdentity(), hostIdentity: createSshIdentity() };
        if (previous) value.soloistKey = key; await save(value); return Object.freeze({ hasKey: true });
      });
    },
    async publicStatus() { await writes.catch(() => {}); return Object.freeze({ hasKey: Boolean(await read()) }); },
    async loadForRuntime() { await writes.catch(() => {}); const value = await read(); if (!value) throw fail('SOLOIST_KEY_REQUIRED'); return value; },
  });
}
module.exports = { createSoloistApplianceSecrets, createSshIdentity, validIdentity, ensurePrivateDirectory };
