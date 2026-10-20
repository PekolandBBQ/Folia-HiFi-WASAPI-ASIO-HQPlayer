import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/spotifyLazyBridge.test.ts — registering IPC must not start the existing desktop bridge.
it('does not construct a bridge, touch a profile, or launch native helpers during registration',()=>{
    const file=new URL('../../../electron/spotify/localUiTrial.cjs',import.meta.url),original=createRequire(file);
    const createBridge=vi.fn(()=>{throw Error('Bridge initialized too early');});
    const register=vi.fn(()=>({registered:true}));
    const module={exports:{} as any};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,global:{},console,process,
        require:(id:string)=>id==='./wrapper/bridge.cjs'?{createBridge}:id==='./cableService.cjs'?{registerCableSpotify:register}:original(id)});
    expect(module.exports.registerLocalUiTrial({})).toEqual({registered:true});
    expect(register).toHaveBeenCalledOnce();expect(createBridge).not.toHaveBeenCalled();
});
