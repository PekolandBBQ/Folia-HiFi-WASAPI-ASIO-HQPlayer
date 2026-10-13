const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createSoloistPcmClient } = require('../../electron/spotify/soloistPcmClient.cjs');
const { createSoloistSshInvoker } = require('../../electron/spotify/soloistSshInvoke.cjs');

// @note Actual isolated-appliance probe; private control responses/PCM descriptors never enter reports.
const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'artifacts/soloist-qemu-20261002/runtime');
const output = path.join(root, 'artifacts/soloist-qemu-20261002');
const controlFailures = [];
function spawnPrivate(executable, args, options) {
    const child = spawn(executable, args, options); let chunks = [], bytes = 0;
    child.stdout.on('data', block => { bytes += block.length; if (bytes <= 65536) chunks.push(Buffer.from(block)); });
    child.on('close', code => {
        if (code !== 0) {
            let errorType = null, httpStatus = null;
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString()), candidate = value.error_type;
                if (['TimeoutError', 'OwnershipError', 'RuntimeError', 'PermissionError', 'FileNotFoundError', 'ClientConnectorError', 'ValueError'].includes(candidate)) errorType = candidate;
                if (Number.isInteger(value.http_status) && value.http_status >= 400 && value.http_status <= 599) httpStatus = value.http_status;
            } catch {}
            controlFailures.push({ code, errorType, httpStatus, stdoutBytes: bytes });
        }
        chunks = [];
    });
    return child;
}
const transport = createSoloistSshInvoker({ keyPath: path.join(runtime, 'appliance_id'), knownHostsPath: path.join(runtime, 'known_hosts'), spawnProcess: spawnPrivate });
let phase = 'preflight';
const invoke = (surface, operation, ...args) => { phase = `${surface}-${operation}`; return transport(surface, operation, ...args); };
const client = createSoloistPcmClient({ invoke });
const cases = [], session = `main-probe-${Date.now()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = error => error?.name === 'AssertionError' ? 'EVIDENCE_ASSERTION_FAILED' : /^[A-Z_]{1,60}$/.test(error?.code || '') ? error.code : 'PROBE_FAILED';
let owned = false, trackId, durationMs;

function official(value) {
    const auth = value?.evidence?.filter(item => item.type === 'auth_state').at(-1);
    const state = value?.evidence?.filter(item => item.type === 'playback_state').at(-1);
    assert.equal(auth?.logged_in, true, 'valid-official-login-required');
    assert.match(state?.uri || '', /^spotify:track:[A-Za-z0-9]{22}$/);
    return { loggedIn: auth.logged_in, active: auth.is_active, trackId: state.uri.slice(14), status: state.status,
        positionMs: state.position_ms, durationMs: state.duration_ms };
}
function collect(readable) {
    const start = performance.now(), digest = crypto.createHash('sha256');
    let bytes = 0, peak = 0, zeroFrames = 0, zeroRun = 0, maxZeroRun = 0, blocks = 0, maxBlockBytes = 0;
    let previous, maxGapMs = 0, firstAudioMs;
    const done = (async () => {
        let termination = 'eof';
        try {
            for await (const block of readable) {
                assert(Buffer.isBuffer(block) && block.length % 8 === 0 && block.length <= 65536);
                const now = performance.now(); firstAudioMs ??= now - start;
                if (previous !== undefined) maxGapMs = Math.max(maxGapMs, now - previous);
                previous = now; blocks++; maxBlockBytes = Math.max(maxBlockBytes, block.length);
                bytes += block.length; digest.update(block);
                for (let offset = 0; offset < block.length; offset += 8) {
                    const left = block.readInt32LE(offset), right = block.readInt32LE(offset + 4);
                    peak = Math.max(peak, Math.abs(left), Math.abs(right));
                    if (!left && !right) { zeroFrames++; zeroRun++; maxZeroRun = Math.max(maxZeroRun, zeroRun); } else zeroRun = 0;
                }
            }
        } catch (error) {
            if (error?.code !== 'CANCELLED') throw error;
            termination = 'cancelled';
        }
        return { bytes, pcmSeconds: bytes / 352800, peak, zeroFrames, maxZeroRunMs: maxZeroRun / 44.1,
            blocks, maxBlockBytes, firstAudioMs, maxGapMs, sha256: digest.digest('hex'), termination };
    })();
    // Attach immediately so an early reader failure is not an unhandled rejection.
    done.catch(() => {});
    return done;
}

(async () => {
    try {
        const ready = await fetch('http://127.0.0.1:28802/status', { signal: AbortSignal.timeout(5000) });
        assert.equal(ready.status, 403);
        const initial = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        trackId = initial.trackId; durationMs = initial.durationMs;
        assert(Number.isSafeInteger(durationMs) && durationMs > 20000 && durationMs < 3600000);
        if (!initial.active) {
            // Re-activate only the previously human-paired research device and its existing track.
            await invoke('soloist', 'play', { uri: `spotify:track:${trackId}`, observe_seconds: 8 });
            const activated = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
            assert.equal(activated.active, true); assert.equal(activated.trackId, trackId);
            cases.push({ name: 'existing-paired-device-reactivated', pass: true, loggedIn: true, active: true });
        }
        const preparedAt = performance.now();
        const prepared = await client.prepare({ session, trackId, positionMs: 0, durationMs }); owned = true;
        assert.equal(prepared.state, 'prepared'); assert(Math.abs(prepared.positionMs) <= 250);
        const positioned = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        assert.equal(positioned.status, 'paused'); assert.equal(positioned.trackId, trackId);
        assert(Math.abs(positioned.positionMs - prepared.positionMs) <= 250);
        cases.push({ name: 'verified-paused-origin', pass: true, generation: prepared.generation,
            prepareMs: performance.now() - preparedAt, positionMs: prepared.positionMs, officialPositionMs: positioned.positionMs });
        const reading = collect(client.openReadable(session));
        assert.throws(() => client.openReadable(session), error => error.code === 'READER_ALREADY_USED');
        await client.play(session); await sleep(8000);
        const running = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        assert.equal(running.active, true); assert.equal(running.status, 'playing'); assert.equal(running.trackId, trackId);
        const state = await client.status(session);
        assert.equal(state.sourceFormat.encodingVerified, false); assert.equal(state.actualQuality, null);
        await client.pause(session);
        const captured = await reading, completion = await prepared.completed;
        assert(captured.bytes > 352800 && captured.peak > 0); assert.equal(completion.kind, 'paused');
        const paused = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        assert.equal(paused.status, 'paused'); assert.equal(paused.trackId, trackId);
        cases.push({ name: 'main-client-real-pcm-and-pause', pass: true, officialPositionMs: running.positionMs,
            preparedAudio: prepared.preparedAudio, sourceFormat: prepared.sourceFormat, actualQuality: null,
            completion: completion.kind, capture: captured });
        const next = await client.seek(session, 15000);
        assert(next.generation > prepared.generation); assert(Math.abs(next.positionMs - 15000) <= 250);
        const seeked = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        assert.equal(seeked.status, 'paused'); assert(Math.abs(seeked.positionMs - next.positionMs) <= 250);
        const resumeReading = collect(client.openReadable(session));
        await client.play(session); await sleep(4000); await client.pause(session);
        const resumed = await resumeReading;
        assert(resumed.bytes > 352800 && resumed.peak > 0); assert.equal((await next.completed).kind, 'paused');
        cases.push({ name: 'verified-new-generation-seek-and-resume', pass: true, previousGeneration: prepared.generation,
            generation: next.generation, requestedPositionMs: 15000, officialOriginMs: seeked.positionMs, capture: resumed });
        await client.close(session); owned = false;
        const final = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
        assert.equal(final.status, 'paused'); assert.equal(final.loggedIn, true);
        cases.push({ name: 'closed-reader-and-login-retained', pass: true, status: final.status, loggedIn: true });
    } catch (error) {
        cases.push({ pass: false, phase, code: safeCode(error) }); process.exitCode = 1;
    } finally {
        if (owned) { try { await client.pause(session); } catch {} try { await client.close(session); } catch {} }
        if (trackId) {
            try {
                const cleanup = official(await invoke('soloist', 'status', { observe_seconds: 1 }));
                if (cleanup.active && cleanup.trackId === trackId && cleanup.status === 'playing')
                    await invoke('soloist', 'pause', { expected_uri: `spotify:track:${trackId}`, observe_seconds: 1 });
            } catch {}
        }
        client.dispose();
        const report = { at: new Date().toISOString(), physicalOutputOpened: false, registeredInFolia: false,
            verifiedSourceQuality: false, cases, controlFailures };
        fs.mkdirSync(output, { recursive: true });
        const file = path.join(output, `main-pcm-client-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ report: file, passed: cases.filter(value => value.pass).length, failed: cases.filter(value => value.pass === false).length }));
    }
})();
