const { setTimeout: delay } = require('node:timers/promises');
const { audioError } = require('./errors.cjs');

// USB drivers can invalidate the first PCM endpoint while leaving HQPlayer's DSD mode.
// Retry only this handoff, with fresh load/probe calls; never switch devices or output modes.
async function reopenAfterHQPlayer(load, { signal, recovering, onRetry = () => {}, wait = delay }) {
    const backoff = recovering ? [300, 900, 1800] : [];
    for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw audioError('CANCELLED');
        try { return await load(); }
        catch (error) {
            if (signal.aborted) throw audioError('CANCELLED');
            if (error.code !== 'DEVICE_UNAVAILABLE' || attempt >= backoff.length) throw error;
            onRetry(attempt + 1);
            await wait(backoff[attempt], undefined, { signal }).catch(() => { throw audioError('CANCELLED'); });
        }
    }
}
module.exports = { reopenAfterHQPlayer };
