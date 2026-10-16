// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpotifyReadiness } from '@/services/onlineMusic/spotifyReadiness';
vi.mock('@/services/onlineMusic/spotifyTransport', () => ({ requestSpotify: vi.fn() }));
// The retry budget belongs to the entire check, not each concurrent UI caller.
describe('Spotify silent readiness', () => {
 it('makes an initial attempt and exactly three retries', async () => {
  const check=vi.fn().mockResolvedValue({ready:false,detail:'连接未响应'});
  const service=createSpotifyReadiness(check,async()=>{});
  expect(await service.run()).toBe(false);expect(check).toHaveBeenCalledTimes(4);
  expect(service.state()).toMatchObject({status:'failed',retries:3,detail:'连接未响应'});
 });
 it('shares concurrent work and stops after recovery',async()=>{
  const check=vi.fn().mockResolvedValueOnce({ready:false}).mockResolvedValue({ready:true});
  const service=createSpotifyReadiness(check,async()=>{});
  const first=service.run();expect(service.run()).toBe(first);expect(await first).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);expect(await service.run()).toBe(true);expect(check).toHaveBeenCalledTimes(2);
 });
 it('does not retry rate limiting',async()=>{
  const check=vi.fn().mockRejectedValue({httpStatus:429});const service=createSpotifyReadiness(check,async()=>{});
  expect(await service.run()).toBe(false);expect(check).toHaveBeenCalledTimes(1);
 });
 it('does not let an old account overwrite a reset result',async()=>{
  let resolve!:(value:{ready:boolean})=>void;
  const check=vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolve=done})).mockResolvedValue({ready:true});
  const service=createSpotifyReadiness(check,async()=>{});const old=service.run();service.reset();await service.run();resolve({ready:false});await old;
  expect(service.state().status).toBe('ready');
 });
 it('retains translated cause instead of an English code',async()=>{
  const service=createSpotifyReadiness(async()=>{throw {message:'BRIDGE_ERROR',details:{userMessage:'Spotify 尚未响应连接请求。'}}},async()=>{});
  await service.run();expect(service.state().detail).toBe('Spotify 尚未响应连接请求。');
 });
});
