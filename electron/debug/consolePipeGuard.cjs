// A launcher may close its output pipe while the desktop app keeps running. Only
// that console sink is disposable; audio pipes and other I/O errors remain fatal.
function installConsolePipeGuard({ streams = [process.stdout, process.stderr], onBrokenPipe = () => {} } = {}) {
    const cleanups = [];
    for (const stream of streams) {
        if (!stream || typeof stream.write !== 'function' || stream.__foliaConsolePipeGuard) continue;
        const original = stream.write;
        let broken = false;
        const markBroken = error => {
            if (error?.code !== 'EPIPE') throw error;
            if (!broken) {
                broken = true;
                try { onBrokenPipe(stream); } catch { /* diagnostics cannot revive a closed console */ }
            }
        };
        const guarded = function (...args) {
            if (broken) return false;
            try { return original.apply(this, args); }
            catch (error) { markBroken(error); return false; }
        };
        stream.__foliaConsolePipeGuard = true;
        stream.write = guarded;
        stream.on('error', markBroken);
        cleanups.push(() => {
            stream.removeListener('error', markBroken);
            if (stream.write === guarded) stream.write = original;
            delete stream.__foliaConsolePipeGuard;
        });
    }
    return () => { for (const cleanup of cleanups) cleanup(); };
}
module.exports = { installConsolePipeGuard };
