'use strict';
const fs = require('node:fs/promises');
const { lstatSync, unlinkSync } = require('node:fs');
const path = require('node:path');
const { fail, validDeviceId, validTrackId, validSessionId } = require('./desktopPlaybackFacts.cjs');

// electron/spotify/desktopPreparationIntent.cjs: retain only the old preparation
// path's uncertain playback writes, independently of preserved volume history.
function createDesktopPreparationIntent(directory) {
  const filename = directory && path.join(directory, 'source-preparation-recovery.json');
  let retained;
  const blocked = () => fail('PLAYBACK_STATE_UNCONFIRMED');
  const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const same = (a, b) => a && b && a.signature === b.signature && a.encoded === b.encoded;
  async function snapshot() {
    if (!filename) return retained || null;
    let before, handle;
    try { before = await fs.lstat(filename, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && !retained) return null; throw blocked(); }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 4096n) throw blocked();
    try {
      handle = await fs.open(filename, 'r');
      if (signature(await handle.stat({ bigint: true })) !== signature(before)) throw blocked();
      const bytes = Buffer.alloc(4097), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
      if (bytesRead !== Number(before.size) || signature(after) !== signature(before)
        || named.isSymbolicLink() || signature(named) !== signature(before)) throw blocked();
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      const value = JSON.parse(encoded);
      if (!value || Object.keys(value).sort().join(',') !== 'deviceId,operation,playbackRequestPending,session,trackId,version'
        || value.version !== 1 || value.playbackRequestPending !== true || !validSessionId(value.session)
        || !validDeviceId(value.deviceId) || !validTrackId(value.trackId)
        || !['cold-activate','cold-select','cold-park','route-park-before','route-select','route-park','cleanup-pause'].includes(value.operation)) throw blocked();
      const result = { value, encoded, signature: signature(before) };
      if (retained && !same(retained, result)) throw blocked();
      return result;
    } catch { throw blocked(); }
    finally { await handle?.close(); }
  }
  async function assertClear() { if (await snapshot()) throw blocked(); }
  async function begin(record, operation) {
    await assertClear();
    const value = { version: 1, session: record.session, deviceId: record.deviceId, trackId: record.trackId,
      operation, playbackRequestPending: true }, encoded = JSON.stringify(value) + '\n';
    if (!filename) return retained = { value, encoded, signature: record.session + operation };
    await fs.mkdir(directory, { recursive: true });
    let handle;
    try { handle = await fs.open(filename, 'wx', 0o600); await handle.writeFile(encoded); await handle.sync(); }
    catch { throw blocked(); }
    finally { await handle?.close(); }
    retained = await snapshot(); return retained;
  }
  async function complete(expected, check) {
    check(); if (!same(await snapshot(), expected)) throw blocked(); check();
    if (filename) {
      const final = lstatSync(filename, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || signature(final) !== expected.signature) throw blocked();
      unlinkSync(filename);
    }
    retained = undefined;
  }
  return { assertClear, begin, complete, snapshot };
}
module.exports = { createDesktopPreparationIntent };
