import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/unit/nativeAudio/hqplayerSession.test.ts — fallback boundaries and original-file ownership.
const { loadHQPlayerSession } = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerSession.cjs');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'folia-hqp-session-')); roots.push(root);
    const directory = path.join(root, 'session'); await mkdir(directory);
    const input = path.join(root, 'original.audio'); await writeFile(input, 'fLaCsource');
    const current = { id: 'one', input, directory, abort: new AbortController(), hqplayerGainDb: -3 };
    const load = vi.fn(async () => ({ session: 'one' }));
    const decode = vi.fn(async () => path.join(directory, 'decoded.wav'));
    const assertCurrent = () => { if (current.abort.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); };
    return { current, hqplayer: { load }, decoder: 'ffmpeg.exe', decode, assertCurrent };
}
describe('HQPlayer source preparation', () => {
    it('retains original files and uses a session-owned extension without decoding', async () => {
        const f = await fixture(); await loadHQPlayerSession(f);
        expect(await readFile(f.current.input, 'utf8')).toBe('fLaCsource');
        expect(f.hqplayer.load).toHaveBeenCalledWith({ session: 'one', gainDb: -3, filePath: path.join(f.current.directory, 'input.flac') });
        expect(f.decode).not.toHaveBeenCalled();
    });
    it('decodes PCM32 only after an explicit source rejection', async () => {
        const f = await fixture(); f.hqplayer.load.mockRejectedValueOnce({ code: 'HQPLAYER_SOURCE_REJECTED' });
        await loadHQPlayerSession(f);
        expect(f.decode).toHaveBeenCalledWith('ffmpeg.exe', path.join(f.current.directory, 'input.flac'), f.current.directory, f.current.abort.signal, 'integer-direct', undefined);
        expect(f.hqplayer.load).toHaveBeenCalledTimes(2);
    });
    it.each(['HQPLAYER_COMMAND_REJECTED', 'HQPLAYER_CONTROL_UNAVAILABLE'])('does not disguise %s as a decoder error', async code => {
        const f = await fixture(); f.hqplayer.load.mockRejectedValueOnce({ code });
        await expect(loadHQPlayerSession(f)).rejects.toMatchObject({ code });
        expect(f.decode).not.toHaveBeenCalled();
    });
    it('never loads a decoder result that completed after cancellation', async () => {
        const f = await fixture(); await writeFile(f.current.input, 'unknown');
        f.decode.mockImplementationOnce(async () => { f.current.abort.abort(); return 'late.wav'; });
        await expect(loadHQPlayerSession(f)).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(f.hqplayer.load).not.toHaveBeenCalled();
    });
});
