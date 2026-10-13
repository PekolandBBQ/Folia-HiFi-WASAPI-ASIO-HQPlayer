const { randomUUID } = require('node:crypto');
const { spotifyError } = require('./errors.cjs');

// Keeps the shared login dialog alive across separate playback and catalog consent flows.
function createLoginCoordinator({ device, catalog, vault, deviceRequired = true, onBegin = () => {} }) {
  let active, generation = 0;
  function cancel(key) {
    if (active?.key !== key) return;
    const entry = active; active = null;
    (entry.phase === 'device' ? device : catalog).cancel(entry.childKey);
  }
  async function begin() {
    if (active) cancel(active.key);
    const expected = ++generation;
    await onBegin();
    if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
    // Soloist owns playback consent separately; never read or refresh its unused legacy vault.
    const phase = !deviceRequired || await vault.token() ? 'catalog' : 'device';
    if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
    const engine = phase === 'device' ? device : catalog;
    const childKey = await engine.begin();
    if (expected !== generation) { engine.cancel(childKey); throw spotifyError('auth-required', 'session-changed'); }
    active = { key: randomUUID(), childKey, phase, pending: null };
    return active.key;
  }
  async function check(key) {
    const entry = active;
    if (!entry || entry.key !== key) return { state: 'expired' };
    if (entry.pending) return entry.pending;
    const task = (async () => {
      const result = await (entry.phase === 'device' ? device : catalog).check(entry.childKey);
      if (active !== entry) return { state: 'expired' };
      if (result.state === 'confirmed' && entry.phase === 'device') {
        const childKey = await catalog.begin();
        if (active !== entry) { catalog.cancel(childKey); return { state: 'expired' }; }
        entry.phase = 'catalog'; entry.childKey = childKey;
        return { state: 'waiting' };
      }
      return result;
    })().finally(() => { entry.pending = null; });
    entry.pending = task; return task;
  }
  return { begin, check, cancel,
    image: key => active?.key === key ? (active.phase === 'device' ? device : catalog).image(active.childKey) : '',
    clear() { generation++; if (active) cancel(active.key); device.clear(); catalog.clear(); } };
}
module.exports = { createLoginCoordinator };
