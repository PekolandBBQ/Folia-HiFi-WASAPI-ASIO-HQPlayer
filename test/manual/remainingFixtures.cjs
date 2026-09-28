const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Generated silence with real FLAC comments; never changes library source files.
async function fixtures(output) {
    const wav = Buffer.alloc(44 + 48000 * 2 * 2 * 24);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    const input = path.join(output, 'silence.wav'); await fs.writeFile(input, wav);
    const entries = [];
    for (const [id, gain] of [['A', -6], ['B', -3]]) {
        const file = path.join(output, `tagged-${id}.flac`);
        execFileSync(path.resolve('../folia-major/build/native-audio/ffmpeg.exe'), ['-v', 'error', '-y', '-i', input, '-c:a', 'flac', '-metadata', `title=Tagged validation ${id}`, '-metadata', `REPLAYGAIN_TRACK_GAIN=${gain} dB`, '-metadata', 'REPLAYGAIN_ALBUM_GAIN=-12 dB', '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.8', file]);
        entries.push({ id, gain, bytes: (await fs.readFile(file)).toString('base64') });
    }
    return entries;
}
async function seed(page, entries) {
    return page.evaluate(async entries => {
        const { parseEmbeddedMetadataAsync } = await import('/src/utils/localMetadataWorkerClient.ts');
        const { saveAudioBlob } = await import('/src/services/audioCache.ts');
        const { saveSongReplayGain } = await import('/src/services/onlineMusic/resourceCache.ts');
        const { getSongResourceCacheKey } = await import('/src/services/onlineMusic/resourceKeys.ts');
        const { saveToCache } = await import('/src/services/db.ts');
        const songs = [];
        for (const entry of entries) {
            const bytes = Uint8Array.from(atob(entry.bytes), c => c.charCodeAt(0));
            const file = new File([bytes], `tagged-${entry.id}.flac`, { type: 'audio/flac' });
            const parsed = await parseEmbeddedMetadataAsync(file);
            if (parsed?.replayGainTrackGain !== entry.gain || parsed?.replayGainAlbumGain !== -12) throw new Error(`Real tag parse failed: ${JSON.stringify(parsed)}`);
            const id = `remaining-validation-${entry.id}`;
            const song = { id, name: `Tagged validation ${entry.id}`, artists: [{ id: 'validation', name: 'Validation' }], album: { id: 'validation', name: 'Validation' }, durationMs: 24000, sourceRef: { kind: 'online', providerId: 'qq', mediaId: id }, isPureMusic: true };
            await saveAudioBlob(getSongResourceCacheKey('audio', song), file);
            await saveSongReplayGain(song, { trackGain: parsed.replayGainTrackGain, albumGain: parsed.replayGainAlbumGain, trackPeak: parsed.replayGainTrackPeak });
            await saveToCache(getSongResourceCacheKey('lyric', song), { lines: [{ time: 0, fullText: '纯音乐，请欣赏', words: [] }] });
            songs.push(song);
        }
        return songs;
    }, entries);
}
module.exports = { fixtures, seed };
