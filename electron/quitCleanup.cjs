'use strict';
// Cleanup gets a bounded opportunity; failures are evidence, never permission to retain the app.
function settleQuitCleanup(run, report, timeoutMs = 3000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { try { report(error); } catch {} }
      resolve();
    };
    const timer = setTimeout(() => finish(Object.assign(Error('QUIT_CLEANUP_TIMEOUT'), { code: 'QUIT_CLEANUP_TIMEOUT' })), timeoutMs);
    Promise.resolve().then(run).then(() => finish(), finish);
  });
}
module.exports = { settleQuitCleanup };
