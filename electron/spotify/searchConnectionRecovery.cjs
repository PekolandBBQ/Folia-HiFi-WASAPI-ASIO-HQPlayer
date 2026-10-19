'use strict';
// Search repairs a proven client/resource mismatch through the existing configuration owner.
function createSearchConnectionRecovery({ ensure, repair, log = () => {} }) {
  let pending;
  return function connect(progress) {
    if (!pending) pending = (async () => {
      try { await ensure(progress); }
      catch (original) {
        if (original.code !== 'SPOTIFY_RESOURCE_VERSION_CHANGED') throw original;
        log('spotify-search-resource-recovery', { phase: 'configuring', originalCode: original.code });
        try {
          await repair();
          await ensure(progress);
          log('spotify-search-resource-recovery', { phase: 'connected' });
        } catch (error) {
          log('spotify-search-resource-recovery', { phase: 'failed', originalCode: original.code, code: error.code, detail: error.detail || error.message });
          throw error;
        }
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createSearchConnectionRecovery };
