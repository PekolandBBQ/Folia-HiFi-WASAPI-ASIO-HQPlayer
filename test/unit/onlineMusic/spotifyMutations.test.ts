import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spotifyMutations } from '@/services/onlineMusic/spotifyMutations';
import { requestSpotify } from '@/services/onlineMusic/spotifyTransport';
import { getAllSpotifySavedTracks } from '@/services/onlineMusic/spotifySavedTracks';
import { normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';
// Remote confirmation and a refreshed remote library are both required before the heart changes.
vi.mock('@/services/onlineMusic/spotifyTransport', () => ({ requestSpotify: vi.fn() }));
vi.mock('@/services/onlineMusic/spotifySavedTracks', () => ({ getAllSpotifySavedTracks: vi.fn() }));
const id = '0123456789012345678901';
const song = normalizeSpotifySong({id,name:'Online',duration_ms:1000,artists:[],album:{name:'Album'}});
beforeEach(()=>vi.clearAllMocks());
describe('Spotify confirmed library mutations',()=>{
 it('refreshes remote saved tracks after like and unlike',async()=>{
  vi.mocked(requestSpotify).mockResolvedValueOnce({trackId:id,liked:true,confirmed:true}).mockResolvedValueOnce({trackId:id,liked:false,confirmed:true});
  vi.mocked(getAllSpotifySavedTracks).mockResolvedValueOnce([song]).mockResolvedValueOnce([]);
  await expect(spotifyMutations.likeSong!(song,true)).resolves.toEqual({likedSongIds:[id],collectionId:'spotify-liked-songs'});
  await expect(spotifyMutations.likeSong!(song,false)).resolves.toEqual({likedSongIds:[],collectionId:'spotify-liked-songs'});
  expect(requestSpotify).toHaveBeenNthCalledWith(1,{action:'likeSong',id,liked:true});
  expect(getAllSpotifySavedTracks).toHaveBeenCalledTimes(2);
 });
 it('does not read or publish a success for an unconfirmed write',async()=>{
  vi.mocked(requestSpotify).mockResolvedValue({trackId:id,liked:true,confirmed:false});
  await expect(spotifyMutations.likeSong!(song,true)).rejects.toThrow('尚未确认');
  expect(getAllSpotifySavedTracks).not.toHaveBeenCalled();
 });
 it('distinguishes a confirmed write from a failed playlist refresh and recovers next time',async()=>{
  vi.mocked(requestSpotify).mockResolvedValue({trackId:id,liked:true,confirmed:true});
  vi.mocked(getAllSpotifySavedTracks).mockRejectedValueOnce(Error('network')).mockResolvedValueOnce([song]);
  await expect(spotifyMutations.likeSong!(song,true)).rejects.toThrow('歌单刷新失败');
  await expect(spotifyMutations.likeSong!(song,true)).resolves.toMatchObject({likedSongIds:[id]});
 });
 it('does not publish an old saved list as a successful mutation',async()=>{
  vi.mocked(requestSpotify).mockResolvedValue({trackId:id,liked:true,confirmed:true});
  vi.mocked(getAllSpotifySavedTracks).mockResolvedValue([]);
  await expect(spotifyMutations.likeSong!(song,true)).rejects.toThrow('尚未同步');
 });
});
