const fs = require('node:fs/promises');
const path = require('node:path');

// electron/nativeAudio/hqplayerSource.cjs — retain a real audio extension for HQPlayer file loading.
const AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.alac', '.caf', '.dff', '.dsf', '.flac',
    '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wave', '.wv']);
const MIME_EXTENSIONS = new Map([
    ['audio/aac', '.aac'], ['audio/aiff', '.aiff'], ['audio/x-aiff', '.aiff'], ['audio/flac', '.flac'],
    ['audio/x-flac', '.flac'], ['audio/mp4', '.m4a'], ['audio/x-m4a', '.m4a'], ['video/mp4', '.m4a'],
    ['audio/mpeg', '.mp3'], ['audio/ogg', '.ogg'], ['application/ogg', '.ogg'], ['audio/opus', '.opus'],
    ['audio/wav', '.wav'], ['audio/wave', '.wav'], ['audio/x-wav', '.wav'], ['audio/vnd.wave', '.wav'],
    ['audio/wavpack', '.wv'], ['audio/x-wavpack', '.wv'],
]);
const UNKNOWN_SOURCE_CODE = 'HQPLAYER_SOURCE_EXTENSION_UNKNOWN';

function extensionFromName(name) {
    if (!name) return '';
    let candidate = name;
    try { candidate = new URL(name).pathname; } catch {}
    const extension = path.extname(candidate).toLowerCase();
    return AUDIO_EXTENSIONS.has(extension) ? extension : '';
}

function resolveAudioExtension({ sourceName = '', url = '', mimeType = '' } = {}) {
    return extensionFromName(sourceName) || extensionFromName(url)
        || MIME_EXTENSIONS.get(String(mimeType).split(';', 1)[0].trim().toLowerCase()) || '';
}

function ascii(buffer, start, length) {
    return buffer.subarray(start, start + length).toString('ascii');
}

async function sniffAudioExtension(sourcePath) {
    const handle = await fs.open(sourcePath, 'r');
    try {
        const header = Buffer.alloc(256);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const bytes = header.subarray(0, bytesRead);
        if (ascii(bytes, 0, 4) === 'fLaC') return '.flac';
        if (['RIFF', 'RF64'].includes(ascii(bytes, 0, 4)) && ascii(bytes, 8, 4) === 'WAVE') return '.wav';
        if (ascii(bytes, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(bytes, 8, 4))) return '.aiff';
        if (ascii(bytes, 0, 4) === 'OggS') return bytes.includes(Buffer.from('OpusHead')) ? '.opus' : '.ogg';
        if (ascii(bytes, 0, 3) === 'ID3') return '.mp3';
        if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return '.aac';
        if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return '.mp3';
        if (ascii(bytes, 4, 4) === 'ftyp') return '.m4a';
        if (ascii(bytes, 0, 4) === 'caff') return '.caf';
        if (ascii(bytes, 0, 4) === 'wvpk') return '.wv';
        if (ascii(bytes, 0, 4) === 'DSD ') return '.dsf';
        if (ascii(bytes, 0, 4) === 'FRM8' && ascii(bytes, 8, 4) === 'DSD ') return '.dff';
        return '';
    } finally {
        await handle.close();
    }
}

async function prepareHQPlayerSource(sourcePath, metadata) {
    if (path.extname(sourcePath).toLowerCase() !== '.audio') return sourcePath;
    const extension = resolveAudioExtension(metadata) || await sniffAudioExtension(sourcePath);
    if (!extension) {
        const error = new Error('HQPlayer source format could not be identified from its filename, MIME type, or file header');
        error.code = UNKNOWN_SOURCE_CODE;
        throw error;
    }
    const destination = path.join(path.dirname(sourcePath), `input${extension}`);
    await fs.rename(sourcePath, destination);
    return destination;
}

module.exports = { prepareHQPlayerSource, resolveAudioExtension, sniffAudioExtension, UNKNOWN_SOURCE_CODE };
