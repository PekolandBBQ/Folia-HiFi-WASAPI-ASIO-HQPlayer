import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// test/unit/electron/transcodeParallelRecovery.test.ts — speculative work cannot outrank strict output.
const { transcodeAudioFile } = createRequire(import.meta.url)('../../../electron/transcode/runner.cjs');
const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(strict: number | null, tolerant: number | null, validate=0, error='invalid frame header') {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'folia-parallel-test-'));roots.push(root);
    const outputPath=path.join(root,'out.flac');await fs.writeFile(outputPath,Buffer.alloc(256,1));await fs.writeFile(`${outputPath}.tolerant`,Buffer.alloc(256,2));
    const calls:string[][]=[],killed:string[]=[];
    const spawnProcess=(_exe:string,args:string[])=>{
        calls.push(args);const kind=args.includes('null')?'validate':args.includes('-xerror')?'strict':'tolerant';
        const child=Object.assign(new EventEmitter(),{stderr:new PassThrough(),kill:()=>{killed.push(kind);return true;}});
        const code=kind==='strict'?strict:kind==='tolerant'?tolerant:validate;
        if(code!==null)queueMicrotask(()=>{if(code)child.stderr.write(error);child.emit('close',code);});
        return child;
    };
    return {calls,killed,outputPath,run:(signal?:AbortSignal)=>transcodeAudioFile({executable:'ffmpeg',inputPath:'same-input',outputPath,format:'flac',spawnProcess,parallel:true,signal})};
}
describe('parallel recovery selection and cancellation',()=>{
    it('keeps strict output and cancels unfinished speculative work',async()=>{
        const f=await fixture(0,null);expect(await f.run()).toEqual({size:256,tolerant:false});
        expect(f.killed).toEqual(['tolerant']);expect((await fs.readFile(f.outputPath))[0]).toBe(1);expect(f.calls).toHaveLength(3);
    });
    it('selects completed tolerant output only after strict corruption and validates it',async()=>{
        const f=await fixture(1,0);expect(await f.run()).toEqual({size:256,tolerant:true});
        expect((await fs.readFile(f.outputPath))[0]).toBe(2);expect(f.calls).toHaveLength(3);expect(f.calls[2]).toContain('-xerror');
    });
    it('cancels both jobs on source cancellation',async()=>{
        const f=await fixture(null,null),c=new AbortController(),result=f.run(c.signal);c.abort();
        await expect(result).rejects.toMatchObject({code:'CANCELLED'});expect(f.killed.sort()).toEqual(['strict','tolerant']);expect(f.calls).toHaveLength(2);
    });
    it('does not select speculative success for a disk or encoder error',async()=>{
        const f=await fixture(1,0,0,'No space left on device');await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'});expect(f.calls).toHaveLength(2);
    });
    it('rejects invalid recovered output without another encode',async()=>{
        const f=await fixture(1,0,1);await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'});expect(f.calls).toHaveLength(3);
    });
    it('fails once when neither decode succeeds',async()=>{
        const f=await fixture(1,1);await expect(f.run()).rejects.toMatchObject({code:'FFMPEG_FAILED'});expect(f.calls).toHaveLength(2);
    });
});
