import { expect,it,vi } from 'vitest';
import {createRequire} from 'node:module';
// test/unit/onlineMusic/playbackConnectionRecovery.test.ts — recover the actual cause before replaying a failed request.
const {prepareWithConnectionRecovery,repairSpotifyOutput}=createRequire(import.meta.url)('../../../electron/spotify/playbackConnectionRecovery.cjs');
const fail=(code:string)=>Object.assign(Error(code),{nativeCode:code,stage:'pcm-prepare'});
function fixture(){return {ensure:vi.fn(async()=>{}),prepare:vi.fn(async()=>({url:'pcm'})),configure:vi.fn(async()=>{}),repairOutput:vi.fn(async()=>{}),current:vi.fn(),log:vi.fn()};}
it('repairs the actual unsafe endpoint even after its stage was projected as pcm-prepare, configures and replays',async()=>{
    const f=fixture();f.prepare.mockRejectedValueOnce(fail('ORIGINAL_ENDPOINT_UNSAFE'));
    await expect(prepareWithConnectionRecovery(f)).resolves.toEqual({url:'pcm'});
    expect(f.repairOutput).toHaveBeenCalledOnce();expect(f.configure).toHaveBeenCalledOnce();expect(f.ensure).toHaveBeenCalledTimes(2);expect(f.prepare).toHaveBeenCalledTimes(2);
});
it('reconfigures a failed handshake instead of waiting on the same bridge',async()=>{
    const f=fixture();f.ensure.mockRejectedValueOnce(fail('SPOTIFY_BRIDGE_NOT_READY'));
    await prepareWithConnectionRecovery(f);expect(f.repairOutput).not.toHaveBeenCalled();expect(f.configure).toHaveBeenCalledOnce();
});
it('does not configure after cancellation or hide the original/recovery failures',async()=>{
    const f=fixture(),original=fail('ORIGINAL_ENDPOINT_UNSAFE'),recovery=Object.assign(Error('native refused repair'),{code:'SPOTIFY_OUTPUT_RESET_UNCONFIRMED'});
    f.prepare.mockRejectedValueOnce(original);f.repairOutput.mockRejectedValueOnce(recovery);
    await expect(prepareWithConnectionRecovery(f)).rejects.toMatchObject({originalFailure:original,code:'SPOTIFY_OUTPUT_RESET_UNCONFIRMED'});
    expect(f.configure).not.toHaveBeenCalled();expect(f.prepare).toHaveBeenCalledOnce();
    const cancelled=fixture();cancelled.ensure.mockRejectedValueOnce(fail('CANCELLED'));
    await expect(prepareWithConnectionRecovery(cancelled)).rejects.toMatchObject({nativeCode:'CANCELLED'});expect(cancelled.configure).not.toHaveBeenCalled();
});
it('uses only the per-Spotify repair command and requires native confirmation that originals were retained',async()=>{
    const execute=vi.fn((_exe:any,args:any,options:any,done:any)=>{expect(args).toEqual(['--repair-spotify-output']);expect(options.windowsHide).toBe(true);done(null,JSON.stringify({repaired:true,globalDefaultsWritten:false,originalPoliciesRetained:true}));});
    await expect(repairSpotifyOutput({componentDirectory:'fixture',current:()=>{},log:()=>{},execute,resolveComponent:async()=>'/verified.exe'})).resolves.toHaveProperty('repaired',true);
});
