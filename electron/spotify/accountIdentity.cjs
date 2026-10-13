const { spotifyError } = require('./errors.cjs');

// Verify both independently authorized grants belong to one account before mixing their data.
function createAccountIdentity({ playbackProfile, catalogProfile }) {
  let generation = 0, pending, verified;
  return {
    ensure({ fresh = false } = {}) {
      if (pending) return pending;
      if (verified && !fresh) return Promise.resolve(verified);
      // Explicit account checks must reach both services, including after a previous success.
      // Drop the old success before checking so a failed refresh cannot authorize later playback.
      verified = undefined;
      const expected = generation;
      const task = Promise.all([playbackProfile(), catalogProfile()]).then(([playback, catalog]) => {
        if (expected !== generation) throw spotifyError('auth-required', 'session-changed');
        if (!playback?.id || playback.id !== catalog?.id) throw spotifyError('auth-required', 'account-mismatch');
        verified = catalog;
        return catalog;
      });
      pending = task;
      const settled = () => { if (pending === task) pending = null; };
      void task.then(settled, settled);
      return task;
    },
    clear() { generation++; pending = null; verified = undefined; },
  };
}
module.exports = { createAccountIdentity };
