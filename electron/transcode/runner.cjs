'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

// Runs a strict encode, retries damaged input once tolerantly, then strictly validates the output.

const MAX_STDERR_CHARS = 32 * 1024;

const appendBounded = (current, chunk) => `${current}${String(chunk)}`.slice(-MAX_STDERR_CHARS);

const runProcess = ({ executable, args, spawnProcess = spawn, signal, timeoutMs = 30 * 60 * 1000 }) => new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const child = spawnProcess(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result);
    };
    const abort = () => {
        child.kill();
        const error = new Error('Transcode cancelled');
        error.code = 'CANCELLED';
        finish(error);
    };
    const timeout = setTimeout(() => {
        child.kill();
        const error = new Error('FFmpeg timed out');
        error.code = 'TIMEOUT';
        finish(error);
    }, timeoutMs);

    signal?.addEventListener('abort', abort, { once: true });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.once('error', error => finish(error));
    child.once('close', code => {
        if (code === 0) finish(null, { stderr });
        else {
            const error = new Error(stderr.trim() || `FFmpeg exited with code ${code}`);
            error.code = 'FFMPEG_FAILED';
            finish(error);
        }
    });
    if (signal?.aborted) abort();
});

const encodeArgs = (inputPath, outputPath, format, tolerant = false) => [
    '-hide_banner', '-nostdin', '-v', 'error', ...(tolerant ? [] : ['-xerror']), '-y',
    '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-ac', '2',
    ...(format === 'flac'
        ? ['-c:a', 'flac', '-compression_level', '5', '-f', 'flac']
        : ['-c:a', 'pcm_s16le', '-f', 'wav']),
    outputPath,
];

const validateArgs = outputPath => [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror',
    '-i', outputPath, '-map', '0:a:0', '-f', 'null', '-',
];

const isDecodeCorruption = error => error?.code === 'FFMPEG_FAILED'
    && /(?:invalid sync code|invalid frame header|error (?:while )?decoding|corrupt(?:ed)? (?:frame|packet)|crc mismatch)/i.test(error.message);

// Only recovery jobs opt in: two encodes share one input, strict success wins, cancellation
// stops both. The speculative file can never overwrite strict output before its verdict.
async function encodeInParallel({ executable, inputPath, outputPath, format, signal, spawnProcess }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const speculativePath = `${outputPath}.tolerant`;
    const strict = runProcess({ executable, args: encodeArgs(inputPath, outputPath, format), signal, spawnProcess });
    const speculative = runProcess({ executable, args: encodeArgs(inputPath, speculativePath, format, true), signal: controller.signal, spawnProcess })
        .then(() => ({ ok: true }), error => ({ ok: false, error }));
    try {
        try { await strict; controller.abort(); await speculative; return false; }
        catch (error) {
            if (signal?.aborted || !isDecodeCorruption(error)) throw error;
            const result = await speculative;
            if (!result.ok) throw result.error;
            if (signal?.aborted) throw Object.assign(new Error('Transcode cancelled'), { code: 'CANCELLED' });
            await fs.promises.rename(speculativePath, outputPath);
            console.info('[TranscodeFallback]', 'tolerant-parallel-selected', { format });
            return true;
        }
    } finally {
        controller.abort(); await speculative;
        signal?.removeEventListener('abort', abort);
        await fs.promises.rm(speculativePath, { force: true }).catch(() => {});
    }
}

const transcodeAudioFile = async ({ executable, inputPath, outputPath, format, signal, spawnProcess, parallel = false }) => {
    let tolerant = false;
    if (parallel) {
        tolerant = await encodeInParallel({ executable, inputPath, outputPath, format, signal, spawnProcess });
    } else {
    try {
        await runProcess({ executable, args: encodeArgs(inputPath, outputPath, format), signal, spawnProcess });
    } catch (error) {
        // Retry only decode corruption, using the same downloaded bytes. Cancellation, missing
        // encoders, disk failures and invalid output must never turn into a second encode loop.
        if (signal?.aborted || !isDecodeCorruption(error)) throw error;
        tolerant = true;
        console.info('[TranscodeFallback]', 'tolerant-decode-retry', { format });
        await runProcess({ executable, args: encodeArgs(inputPath, outputPath, format, true), signal, spawnProcess });
    }
    }
    const stat = await fs.promises.stat(outputPath);
    if (!stat.isFile() || stat.size < 128) {
        const error = new Error('FFmpeg produced an empty audio file');
        error.code = 'INVALID_OUTPUT';
        throw error;
    }
    await runProcess({ executable, args: validateArgs(outputPath), signal, spawnProcess });
    return { size: stat.size, tolerant };
};

module.exports = { encodeArgs, runProcess, transcodeAudioFile, validateArgs };
