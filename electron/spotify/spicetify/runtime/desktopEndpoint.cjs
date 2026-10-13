'use strict';
const { createDesktopStateObserver } = require('../vendor/stage05/observer/createDesktopStateObserver.cjs');
const { preparePlayerApiCall } = require('../vendor/stage05/commands/player-api-call.cjs');
const { data, fail } = require('../vendor/stage05/commands/command-schema.cjs');

// runtime/desktopEndpoint.cjs: dormant opt-in endpoint; importing never touches Spotify or registers a listener.
function createDesktopEndpoint({ port, getPlayerAPI, getConnectAPI, now = Date.now }) {
  let closed = false, latest = null, issued = 0;
  const observer = createDesktopStateObserver({ getPlayerAPI, getConnectAPI, now,
    // Deliberately no UserAPI. This channel carries diagnostic data, never identity authority.
    emit(record) { latest = record; port.publish({ type: 'observation', record }); } });
  port.onClose(() => { closed = true; observer.dispose(); });
  port.bind(async (frame, dispatch) => {
    if (closed) throw fail('CLOSED');
    if (frame.operation === 'start') return observer.start();
    if (frame.operation === 'snapshot') { observer.snapshot(); return { observation: latest }; }
    if (frame.operation === 'stop') { observer.stop(); return { stopped: true }; }
    if (frame.operation !== 'command') throw fail('OPERATION_DENIED');
    const payload = data(frame.payload, ['command']);
    const prepared = preparePlayerApiCall(getPlayerAPI, 'origin', payload.command);
    dispatch.commit();
    const commandId = ++issued;
    // Call outcome is NOT audio completion, a state observation, or a no-late-effect receipt.
    let result;
    try { result = prepared.invoke(); } catch { return { commandId, call: 'threw', completion: 'unknown' }; }
    if (result == null || typeof result.then !== 'function') return { commandId, call: 'returned', completion: 'unknown' };
    try { await result; return { commandId, call: 'fulfilled', completion: 'unknown' }; }
    catch { return { commandId, call: 'rejected', completion: 'unknown' }; }
  });
  return Object.freeze({ close() { if (closed) return; closed = true; observer.dispose(); port.close(); },
    inspect: () => ({ closed, issued, observer: observer.getSupportReport(), productAdmissible: false }) });
}
module.exports = { createDesktopEndpoint };
