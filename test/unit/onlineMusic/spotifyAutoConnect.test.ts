import { describe, expect, it, vi } from 'vitest';
import { createSpotifyAutoConnect } from '@/services/onlineMusic/spotifyAutoConnect';
vi.mock('@/services/onlineMusic/spotifyTransport',()=>({requestSpotify:vi.fn()}));
// Verify actual step selection, including asynchronous installer completion and safe reuse.
const healthy={ready:true,connected:true,cli:true,wrapper:true,extension:true,engine:true,driver:true,driverCurrent:true,driverEndpointsReady:true,selected:'desktop',installations:[{id:'desktop'}],install:{busy:false,phase:'complete'}};
describe('automatic Spotify configuration',()=>{
 it('reuses a complete running connection without reinstall or configure',async()=>{const request=vi.fn().mockResolvedValue(healthy);expect((await createSpotifyAutoConnect(request)()).ready).toBe(true);expect(request.mock.calls.map(x=>x[0])).toEqual(['status']);});
 it('installs missing components, waits, configures and connects',async()=>{
  const missing={...healthy,ready:false,connected:false,cli:false,wrapper:false,extension:false};
  const request=vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce({...missing,install:{busy:true,phase:'spicetify'}}).mockResolvedValueOnce({...missing,cli:true,install:{busy:false,phase:'installed'}}).mockResolvedValueOnce({...healthy,ready:false,connected:false}).mockResolvedValueOnce(healthy);
  expect((await createSpotifyAutoConnect(request,async()=>{})()).ready).toBe(true);
  expect(request.mock.calls.map(x=>x[0])).toEqual(['status','install','status','configure','launch']);
 });
 it('repairs an old extension without repeating installation',async()=>{const request=vi.fn().mockResolvedValueOnce({...healthy,ready:false,extension:false}).mockResolvedValueOnce(healthy);expect((await createSpotifyAutoConnect(request)()).ready).toBe(true);expect(request.mock.calls.map(x=>x[0])).toEqual(['status','configure']);});
 it('launches an already configured but disconnected Spotify',async()=>{const request=vi.fn().mockResolvedValueOnce({...healthy,ready:false,connected:false}).mockResolvedValueOnce(healthy);await createSpotifyAutoConnect(request)();expect(request.mock.calls.map(x=>x[0])).toEqual(['status','launch']);});
 it('reconfigures a failed handshake and launches again instead of replaying the same failed connection',async()=>{
  const request=vi.fn().mockResolvedValueOnce({...healthy,ready:false,connected:false})
   .mockRejectedValueOnce({code:'provider-error',details:{nativeCode:'SPOTIFY_BRIDGE_NOT_READY'}})
   .mockResolvedValueOnce({...healthy,ready:false,connected:false}).mockResolvedValueOnce(healthy);
  expect((await createSpotifyAutoConnect(request,async()=>{})()).ready).toBe(true);
  expect(request.mock.calls.map(x=>x[0])).toEqual(['status','launch','configure','launch']);
 });
 it('keeps an unsuccessful automatic configuration concrete and does not launch after it failed',async()=>{
  const request=vi.fn().mockResolvedValueOnce({...healthy,ready:false,connected:false})
   .mockRejectedValueOnce({code:'SPOTIFY_RESOURCE_VERSION_CHANGED'})
   .mockResolvedValueOnce({...healthy,ready:false,install:{busy:false,phase:'failed',detail:'当前资源准备失败'}});
  expect((await createSpotifyAutoConnect(request)()).detail).toBe('当前资源准备失败');
  expect(request.mock.calls.map(x=>x[0])).toEqual(['status','launch','configure']);
 });
 it('preserves an unrelated launch failure instead of hiding it behind configuration',async()=>{
  const error={code:'CANCELLED'},request=vi.fn().mockResolvedValueOnce({...healthy,ready:false,connected:false}).mockRejectedValueOnce(error);
  await expect(createSpotifyAutoConnect(request)()).rejects.toBe(error);
  expect(request.mock.calls.map(x=>x[0])).toEqual(['status','launch']);
 });
 it('preserves the reboot receipt instead of reinstalling',async()=>{const request=vi.fn().mockResolvedValue({...healthy,install:{busy:false,phase:'restart-required',restartRequired:true}});expect((await createSpotifyAutoConnect(request)()).detail).toContain('重启 Windows');expect(request).toHaveBeenCalledTimes(1);});
 it('does not install Spotify itself or repeatedly reopen a cancelled driver installer',async()=>{const request=vi.fn().mockResolvedValueOnce({...healthy,installations:[]}).mockResolvedValueOnce({...healthy,driver:false,install:{busy:false,phase:'failed',code:'SPOTIFY_DRIVER_INSTALL_NOT_COMPLETED'}});const run=createSpotifyAutoConnect(request);expect((await run()).detail).toContain('自行安装');expect((await run()).detail).toContain('驱动安装未完成');expect(request.mock.calls.map(x=>x[0])).toEqual(['status','status']);});
});
