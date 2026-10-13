const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { StreamPcmWave } = require('./streamPcmWave.cjs');
const { audioError } = require('./errors.cjs');

// Progressive source → FFmpeg → a private binary PCM pipe. No audio bytes enter renderer IPC.
async function decodeStream({ executable, source, signal: ownerSignal, position, compatibilityMode, onFormat, connectPipe = name => net.createConnection({ path: `\\\\.\\pipe\\${name}`, allowHalfOpen: true }) }) {
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort(); ownerSignal.addEventListener('abort', cancel, { once: true });
    if (ownerSignal.aborted) cancel();
    const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error',
        ...(!compatibilityMode ? ['-xerror'] : []), '-protocol_whitelist', 'file,pipe',
        '-probesize', '8192', '-analyzeduration', '100000', '-i', 'pipe:0',
        ...(position > 0 ? ['-ss', String(position)] : []), '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-c:a', 'pcm_s32le', '-flush_packets', '1', '-f', 'wav', 'pipe:1'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '', socket, processError, inputError, inputEof = false;
    const inputController = new AbortController();
    child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-4096); });
    child.once('error', error => { processError = error; });
    child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', code => {
        // A failed decoder cannot consume another network packet. Interrupt only its reader,
        // leaving the session-owned download available for a fallback or a later seek.
        if (!inputEof) inputController.abort();
        resolve(code);
    }));
    const abort = () => { inputController.abort(); socket?.destroy(); child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const input = (async () => {
        try {
            for await (const bytes of source.chunks(inputController.signal)) {
                signal.throwIfAborted();
                if (child.stdin.destroyed) throw new Error('Decoder input closed');
                if (!child.stdin.write(bytes)) await once(child.stdin, 'drain', { signal });
            }
            inputEof = true; child.stdin.end();
        } catch (error) { inputError = error; child.kill(); }
    })();
    const wave = new StreamPcmWave(); let decodedBytes = 0;
    try {
        for await (const data of child.stdout) {
            const chunks = wave.feed(data);
            if (wave.format && !socket) {
                const pipeName = await onFormat(wave.format);
                signal.throwIfAborted(); socket = connectPipe(pipeName);
                socket.on('error', () => {});
                await once(socket, 'connect', { signal });
            }
            for (const bytes of chunks) {
                signal.throwIfAborted();
                if (socket.destroyed) throw audioError('COMPONENT_CRASHED', 'PCM pipe closed');
                if (!socket.write(bytes)) await once(socket, 'drain', { signal });
                decodedBytes += bytes.length;
            }
        }
        await input;
        const code = await closed;
        signal.throwIfAborted();
        if (typeof inputError?.code === 'string' && inputError.code.startsWith('SOURCE_')) throw inputError;
        if (processError || code !== 0 || inputError) {
            const message = diagnostics || processError?.message || inputError?.message || `Stream decode failed (${code})`;
            throw audioError(!compatibilityMode && /invalid sync code|invalid frame header|error (?:while )?decoding|corrupt(?:ed)? (?:frame|packet)|crc mismatch/i.test(message) ? 'STRICT_DECODE_FAILED' : 'DECODE_FAILED', message);
        }
        wave.finish();
        if (socket && !socket.destroyed) { socket.end(); await once(socket, 'close', { signal }); }
        return { decodedBytes, format: wave.format };
    } finally {
        controller.abort(); ownerSignal.removeEventListener('abort', cancel);
        signal.removeEventListener('abort', abort); socket?.destroy(); child.kill();
        await input; await closed;
    }
}
module.exports = { decodeStream };
