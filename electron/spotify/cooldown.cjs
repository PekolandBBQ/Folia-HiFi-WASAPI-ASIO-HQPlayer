const fs = require('node:fs/promises');
const path = require('node:path');

// Persist service-directed cooldowns so restarting Folia cannot accidentally retry early.
function retryDeadline(header, now) {
  const seconds = typeof header === 'string' && header.trim() !== '' ? Number(header) : NaN;
  const date = Date.parse(header);
  return Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000
    : Number.isFinite(date) && date > now ? date : now + 60000;
}
function createCooldown({ directory, now = Date.now }) {
  const file = directory && path.join(directory, 'catalog-cooldown.json');
  let until = 0, loaded, writes = Promise.resolve();
  async function load() {
    if (!loaded) loaded = (async () => {
      if (!file) return;
      try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Number.isFinite(value.until)) until = Math.max(until, value.until);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    await loaded;
    return until;
  }
  async function defer(header) {
    await load();
    until = Math.max(until, retryDeadline(header, now()));
    if (file) {
      const value = until;
      const write = writes.catch(() => {}).then(async () => {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(file + '.tmp', JSON.stringify({ until: value }));
        await fs.rename(file + '.tmp', file);
      });
      writes = write;
      await write;
    }
    return until;
  }
  return { load, defer };
}
module.exports = { createCooldown, retryDeadline };
