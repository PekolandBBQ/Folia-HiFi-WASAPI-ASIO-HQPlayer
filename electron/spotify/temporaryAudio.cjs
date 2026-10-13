const fs = require('node:fs/promises');
const path = require('node:path');

// Reclaim only this component's orphaned files; never follow links or remove a live process's workspace.
const FOLDER = /^playback-[A-Za-z0-9]{6}$/;
const AUDIO = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.wav$/;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function sweepTemporaryAudio(directory, { alive = processAlive, now = Date.now } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !FOLDER.test(entry.name)) continue;
    const folder = path.join(root, entry.name);
    try {
      if (await fs.realpath(folder) !== folder) continue;
      const marker = path.join(folder, 'owner.json');
      let owner;
      try {
        const stat = await fs.lstat(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue;
        owner = JSON.parse(await fs.readFile(marker, 'utf8'));
        if (owner?.format !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid)) continue;
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
        // Older previews did not write ownership markers. Leave recent legacy workspaces alone.
        if (now() - (await fs.stat(folder)).mtimeMs < 24 * 60 * 60 * 1000) continue;
      }
      const files = await fs.readdir(folder, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !AUDIO.test(file.name)) continue;
        await fs.unlink(path.join(folder, file.name)).catch(() => {});
      }
      // Keep the dead owner's marker if an audio file is locked so the next run can retry immediately.
      const remaining = await fs.readdir(folder);
      if (owner && !remaining.some(name => AUDIO.test(name))) await fs.unlink(marker).catch(() => {});
      // Unexpected contents are preserved; this is deliberately not a recursive deletion.
      await fs.rmdir(folder).catch(() => {});
    } catch { /* Locked or concurrently removed workspaces can be retried at the next start. */ }
  }
}
async function createTemporaryAudioDirectory(directory) {
  await sweepTemporaryAudio(directory);
  const folder = await fs.mkdtemp(path.join(await fs.realpath(directory), 'playback-'));
  await fs.writeFile(path.join(folder, 'owner.json'), JSON.stringify({ format: 1, pid: process.pid }), { flag: 'wx' });
  return folder;
}
async function closeTemporaryAudioDirectory(folder) {
  if ((await fs.readdir(folder)).some(name => AUDIO.test(name))) return;
  await fs.unlink(path.join(folder, 'owner.json')).catch(() => {});
  await fs.rmdir(folder).catch(() => {});
}
module.exports = { sweepTemporaryAudio, createTemporaryAudioDirectory, closeTemporaryAudioDirectory };
