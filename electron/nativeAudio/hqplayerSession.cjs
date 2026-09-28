const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareHQPlayerSource, UNKNOWN_SOURCE_CODE } = require('./hqplayerSource.cjs');
const { audioError } = require('./errors.cjs');

// electron/nativeAudio/hqplayerSession.cjs — preserve source audio, decode only explicitly rejected containers.
async function loadHQPlayerSession({ current, hqplayer, decoder, decode, assertCurrent }) {
    let prepared = current.input, fallback = false, result;
    try {
        // Only rename session-owned copies, never a user's original .audio file.
        if (path.extname(prepared).toLowerCase() === '.audio' && path.dirname(prepared) !== current.directory) {
            prepared = path.join(current.directory, 'input.audio');
            await fs.copyFile(current.input, prepared);
        }
        prepared = await prepareHQPlayerSource(prepared, {
            sourceName: current.sourceName, url: current.remoteUrl, mimeType: current.sourceMimeType,
        });
    } catch (error) {
        if (error?.code !== UNKNOWN_SOURCE_CODE) throw error;
        fallback = true;
    }
    assertCurrent(current);
    if (!fallback) {
        try { result = await hqplayer.load({ session: current.id, filePath: prepared, gainDb: current.hqplayerGainDb }); }
        catch (error) { if (error?.code !== 'HQPLAYER_SOURCE_REJECTED') throw error; fallback = true; }
    }
    assertCurrent(current);
    if (fallback) {
        const wav = await decode(decoder, prepared, current.directory, current.abort.signal, 'integer-direct')
            .catch(error => { throw audioError(current.abort.signal.aborted ? 'CANCELLED' : 'DECODE_FAILED', error.message); });
        assertCurrent(current);
        result = await hqplayer.load({ session: current.id, filePath: wav, gainDb: current.hqplayerGainDb });
    }
    assertCurrent(current);
    return result;
}
module.exports = { loadHQPlayerSession };
