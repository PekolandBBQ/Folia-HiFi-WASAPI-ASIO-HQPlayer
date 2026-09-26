const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// electron/nativeAudio/decode.cjs — decode one local file into a seekable temporary PCM WAV.
async function decodeLocalAudio(executable, input, directory, signal, processingMode = 'compatibility') {
    const stat = await fs.stat(input);
    if (!stat.isFile()) throw new Error('Select a local audio file');
    const output = path.join(directory, 'decoded.wav');
    await new Promise((resolve, reject) => {
        const process = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error',
            '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
            '-c:a', processingMode === 'integer-direct' ? 'pcm_s32le' : 'pcm_s24le',
            '-rf64', 'auto', '-y', output],
        { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        let processError = null;
        process.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4096); });
        process.once('error', error => { processError = error; });
        process.once('close', code => {
            if (processError) reject(processError);
            else if (code !== 0) reject(new Error(diagnostics || `Audio decoding failed (${code})`));
            else resolve();
        });
    });
    if ((await fs.stat(output)).size > 0xffffffff) throw new Error('Decoded audio exceeds the V1 4 GiB WAV limit');
    return output;
}
module.exports = { decodeLocalAudio };
