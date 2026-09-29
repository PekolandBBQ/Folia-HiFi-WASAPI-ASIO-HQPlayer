import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// test/unit/electron/transcodeTolerantRecovery.test.ts — bounded retries still require valid output.
const { transcodeAudioFile } = createRequire(import.meta.url)('../../../electron/transcode/runner.cjs');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive:true, force:true }); });
async function setup(outcomes: Array<{ code: number; error?: string }>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'folia-tolerant-test-')); roots.push(root);
    const outputPath = path.join(root,'out.flac'); await fs.writeFile(outputPath,Buffer.alloc(256));
    const calls: string[][] = [];
    const spawnProcess = (_exe: string, args: string[]) => {
        calls.push(args); const child = Object.assign(new EventEmitter(), { stderr:new PassThrough(), kill:() => true });
        const outcome = outcomes.shift();
        queueMicrotask(() => { child.stderr.write(outcome?.error || ''); child.emit('close',outcome?.code ?? 99); });
        return child;
    };
    return { calls, outputPath, run: (allowTolerant = true) => transcodeAudioFile({ executable:'ffmpeg',inputPath:'same-input.flac',outputPath,format:'flac',spawnProcess,allowTolerant }) };
}
describe('transparent tolerant transcode recovery', () => {
    it('retries corruption once and strictly validates the recovered output', async () => {
        const f = await setup([{code:1,error:'invalid sync code; invalid frame header'}, {code:0}, {code:0}]);
        expect(await f.run()).toEqual({size:256,tolerant:true});
        expect(f.calls).toHaveLength(3);
        expect(f.calls[0]).toContain('-xerror'); expect(f.calls[1]).not.toContain('-xerror'); expect(f.calls[2]).toContain('-xerror');
        expect(f.calls[0][f.calls[0].indexOf('-i')+1]).toBe(f.calls[1][f.calls[1].indexOf('-i')+1]);
    });
    it('does not accept a failed tolerant encode or retry indefinitely', async () => {
        const f = await setup([{code:1,error:'invalid frame header'}, {code:1,error:'error while decoding'}]);
        await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'}); expect(f.calls).toHaveLength(2);
    });
    it('rejects recovered output when full strict output validation fails', async () => {
        const f = await setup([{code:1,error:'invalid frame header'}, {code:0}, {code:1,error:'invalid frame header'}]);
        await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'}); expect(f.calls).toHaveLength(3);
    });
    it.each(['Unknown encoder flac','No space left on device','Permission denied','Invalid data found when processing input'])('does not hide unrelated errors: %s', async error => {
        const f = await setup([{code:1,error}]); await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'}); expect(f.calls).toHaveLength(1);
    });
    it('keeps the successful strict path unchanged', async () => {
        const f = await setup([{code:0},{code:0}]); expect(await f.run()).toEqual({size:256,tolerant:false}); expect(f.calls).toHaveLength(2);
    });
    it('rejects an empty tolerant output before publishing', async () => {
        const f = await setup([{code:1,error:'invalid frame header'},{code:0}]); await fs.writeFile(f.outputPath,Buffer.alloc(0));
        await expect(f.run()).rejects.toMatchObject({code:'INVALID_OUTPUT'}); expect(f.calls).toHaveLength(2);
    });
});

it('requires permission before any tolerant retry when compatibility is disabled', async () => {
 const f = await setup([{code:1,error:'invalid frame header'},{code:0}]);
 await expect(f.run(false)).rejects.toMatchObject({code:'STRICT_DECODE_FAILED'});
 expect(f.calls).toHaveLength(1);
});
