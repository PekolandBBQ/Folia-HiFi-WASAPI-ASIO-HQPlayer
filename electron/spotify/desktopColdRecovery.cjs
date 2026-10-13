'use strict';
const fs = require('node:fs/promises');
const { lstatSync, unlinkSync, renameSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { fail, validDeviceId, validTrackId, validSessionId, sameStamp } = require('./desktopPlaybackFacts.cjs');

// electron/spotify/desktopColdRecovery.cjs: bounded, private interruption receipt; never playback or old-grant authority.
function createColdVolumeReceipt(directory) {
  const filename = directory && path.join(directory, 'cold-volume-recovery.json');
  let retained, owner;
  const blocked = () => fail('BOOTSTRAP_VOLUME_RECOVERY_REQUIRED');
  const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const same = (a, b) => a && b && a.signature === b.signature && a.encoded === b.encoded;
  function validate(value) {
    const keys = value?.version === 2
      ? 'baselineEmpty,deviceId,originalVolume,playbackRequestPending,session,targetActive,trackId,version,volumeOnly,volumeRequestPending'
      : 'deviceId,originalVolume,session,trackId,version';
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== keys
      || ![1, 2].includes(value.version) || !validSessionId(value.session) || !validDeviceId(value.deviceId) || !validTrackId(value.trackId)
      || value.version === 2 && !['baselineEmpty', 'targetActive', 'volumeOnly', 'volumeRequestPending', 'playbackRequestPending'].every(key => typeof value[key] === 'boolean')
      || !Number.isInteger(value.originalVolume) || value.originalVolume < 0 || value.originalVolume > 100) throw blocked();
    return value;
  }
  async function snapshot() {
    if (!filename) return retained || null;
    let before;
    try { before = await fs.lstat(filename, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && !retained) return null; throw blocked(); }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 4096n) throw blocked();
    let handle;
    try {
      handle = await fs.open(filename, 'r');
      if (signature(await handle.stat({ bigint: true })) !== signature(before)) throw blocked();
      const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
      if (bytesRead !== Number(before.size) || signature(after) !== signature(before)
        || named.isSymbolicLink() || signature(named) !== signature(before)) throw blocked();
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      const result = { value: validate(JSON.parse(encoded)), encoded, signature: signature(before) };
      if (retained && !same(result, retained)) throw blocked();
      return result;
    } catch { throw blocked(); }
    finally { await handle?.close(); }
  }
  async function inspect() {
    try {
      const value = (await snapshot())?.value;
      return value ? { required: true, recoverable: true, deviceId: value.deviceId, originalVolume: value.originalVolume }
        : { required: false, recoverable: false };
    } catch { return { required: true, recoverable: false }; }
  }
  async function assertClear() {
    if (retained || await snapshot()) throw blocked();
  }
  async function retain(record, originalVolume) {
    await assertClear();
    const value = validate({ version: 2, session: record.session, deviceId: record.deviceId, trackId: record.trackId, originalVolume,
      baselineEmpty: record.coldBaselineEmpty, targetActive: record.coldInitialTargetActive,
      volumeOnly: true, volumeRequestPending: false, playbackRequestPending: false });
    const encoded = JSON.stringify(value) + '\n';
    if (filename) {
      await fs.mkdir(directory, { recursive: true });
      let handle;
      try {
        handle = await fs.open(filename, 'wx', 0o600);
        await handle.writeFile(encoded); await handle.sync();
      } catch { throw blocked(); }
      finally { await handle?.close(); }
      retained = await snapshot();
    } else retained = { value, encoded, signature: record.session };
    record.coldVolumeReceipt = retained.value;
    owner = { session: record.session, deviceId: record.deviceId, stamp: { ...record.stamp } };
  }
  // Write ahead before dispatch. Unknown/pending cannot become false merely from
  // a restart, elapsed time, or a later observation of the previous volume.
  async function update(record, change) {
    if (retained?.value !== record.coldVolumeReceipt || retained.value.version !== 2) throw blocked();
    const expected = retained, value = validate({ ...expected.value, ...change });
    const encoded = JSON.stringify(value) + '\n';
    if (!same(await snapshot(), expected)) throw blocked();
    if (encoded === expected.encoded) return;
    if (!filename) retained = { value, encoded, signature: randomUUID() };
    else {
      const temporary = filename + '.' + randomUUID() + '.next';
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = undefined;
        if (!same(await snapshot(), expected)) throw blocked();
        const final = lstatSync(filename, { bigint: true });
        if (!final.isFile() || final.isSymbolicLink() || signature(final) !== expected.signature) throw blocked();
        renameSync(temporary, filename);
        retained = { value, encoded, signature: signature(lstatSync(filename, { bigint: true })) };
      } catch { throw blocked(); }
      finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
    }
    record.coldVolumeReceipt = retained.value;
  }
  const setVolumePending = (record, pending) => {
    if (typeof pending !== 'boolean') throw blocked();
    return update(record, { volumeRequestPending: pending });
  };
  const crossPlaybackBoundary = record => update(record, { volumeOnly: false });
  const setPlaybackPending = (record, pending) => {
    if (typeof pending !== 'boolean') throw blocked();
    return update(record, { playbackRequestPending: pending });
  };
  // Re-read the entire bounded receipt before deleting only that unchanged marker.
  // The final synchronous unlink cannot interleave with a newer JS playback intent.
  async function clearSnapshot(expected, assertCurrent = () => {}) {
    assertCurrent();
    if (!same(await snapshot(), expected)) throw blocked();
    assertCurrent();
    if (filename) {
      const final = lstatSync(filename, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || signature(final) !== expected.signature) throw blocked();
      unlinkSync(filename);
    }
    retained = undefined;
    owner = undefined;
  }
  async function clear(record, assertCurrent) {
    if (retained?.value !== record.coldVolumeReceipt) throw blocked();
    await clearSnapshot(retained, assertCurrent); record.coldVolumeReceipt = undefined;
  }
  // Explicit recovery may attach a fresh authorized observation lease only to
  // the unchanged, settled v2 receipt. It does not reset or rewrite uncertainty.
  async function adoptSettled(record, expected) {
    if (!expected || expected.value.version !== 2 || expected.value.volumeRequestPending
      || expected.value.playbackRequestPending || expected.value.deviceId !== record.deviceId
      || !same(await snapshot(), expected)) throw blocked();
    retained = expected;
    record.coldVolumeReceipt = retained.value;
  }
  // This evidence exists only for a receipt created by this controller process.
  // Reading/adopting an old file cannot grant automatic next-Play recovery.
  function isOwned(expected, stamp) {
    return !!owner && !!retained && same(expected, retained) && expected.value.version === 2
      && owner.session === expected.value.session && owner.deviceId === expected.value.deviceId
      && !expected.value.volumeRequestPending && !expected.value.playbackRequestPending && sameStamp(owner.stamp, stamp);
  }
  return { assertClear, retain, clear, snapshot, clearSnapshot, inspect, setVolumePending, crossPlaybackBoundary, setPlaybackPending, adoptSettled, isOwned };
}

module.exports = { createColdVolumeReceipt };
