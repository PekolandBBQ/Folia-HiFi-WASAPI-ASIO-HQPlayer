import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {spotifyProvider} from '@/services/onlineMusic/spotifyProvider';
import {omni} from '@/services/onlineMusic/omni';
import {useSearchNavigationStore} from '@/stores/useSearchNavigationStore';
import {subscribeOnlineLibraryChanges} from '@/services/onlineMusic/libraryChanges';
import {createFavoriteArtistsFeed} from '@/library/core/services/onlineHomeFeeds';
import {registerOnlineMusicProvider,unregisterOnlineMusicProvider} from '@/services/onlineMusic/providerRegistry';

// Test the real adapter, Omni routing and search store against a controlled IPC boundary.
const id='0123456789012345678901',other='1123456789012345678901';
const raw=(type:string,key=id)=>({id:key,type,name:`Remote ${type}`,images:[{url:'https://i.scdn.co/image/test'}]});
const deps={localSongs:[],t:(key:string)=>key};
beforeEach(()=>{registerOnlineMusicProvider(spotifyProvider);useSearchNavigationStore.getState().resetRuntime('spotify');});
afterEach(()=>{unregisterOnlineMusicProvider('spotify');vi.unstubAllGlobals();});
function runtime(){
 let saved=false,account='me',fail=false,staleLists=0;
 const calls:any[]=[],request=vi.fn(async(input:any)=>{
  calls.push(input);
  if(input.action==='searchArtists'||input.action==='searchAlbums')return {items:[raw(input.action==='searchArtists'?'artist':'album',input.offset?other:id)],total:2,consumed:1,next:!input.offset};
  if(input.action==='subscribeCollection'){
   if(fail)throw Error('写入未确认');saved=input.subscribed;
   return {id:input.id,type:input.collectionType,subscribed:input.subscribed,confirmed:true,accountId:'me'};
  }
  if(input.action==='subscriptionStatus')return {subscribed:saved};
  if(input.action==='status')return {id:account,display_name:account};
  if(input.action==='albums'||input.action==='artists')return {items:saved&&staleLists--<=0?[raw(input.action==='albums'?'album':'artist')]:[],next:false};
  throw Error('Unexpected '+input.action);
 });
 vi.stubGlobal('window',{electron:{spotify:{request}}});
 return {request,calls,fail:()=>{fail=true;},account:()=>{account='other';},stale:()=>{staleLists=1;}};
}
describe('Spotify catalog search and remote collection subscriptions',()=>{
 for(const kind of ['albums','artists'] as const)it(`routes ${kind} search through Omni with independent pagination/cache`,async()=>{
  const f=runtime(),store=useSearchNavigationStore.getState();store.setSearchKind(kind);
  await store.submitSearch({query:'Online',sourceTab:'spotify',deps});
  expect(useSearchNavigationStore.getState().searchCollections?.[0]).toMatchObject({id,type:kind==='albums'?'album':'artist',providerId:'spotify'});
  await useSearchNavigationStore.getState().loadMoreSearchResults({deps});
  expect(useSearchNavigationStore.getState().searchCollections?.map(item=>item.id)).toEqual([id,other]);
  expect(useSearchNavigationStore.getState().hasMore).toBe(false);expect(f.calls.map(c=>c.offset)).toEqual([0,1]);
 });
 for(const kind of ['album','artist'] as const)it(`confirms ${kind} write, reads Spotify library and publishes the actual refreshed snapshot`,async()=>{
  const f=runtime(),events:any[]=[],unsubscribe=subscribeOnlineLibraryChanges(value=>events.push(value));
  const collection={providerId:'spotify',id,name:'Remote',type:kind};
  expect(omni.canSubscribeCollection(collection)).toBe(true);
  await omni.subscribe(collection,true);await omni.subscribe(collection,false);unsubscribe();
  expect(events.map(event=>[event.kind,event.subscribed,event.collections.length])).toEqual([[kind,true,1],[kind,false,0]]);
  expect(f.calls.map(c=>c.action)).toContain(kind==='album'?'albums':'artists');
  expect(events[0].accountId).toBe('me');expect(await omni.getSubscriptionStatus(collection)).toBe(false);
 });
 it('does not publish success on write rejection or an account change',async()=>{
  const f=runtime(),events:any[]=[],unsubscribe=subscribeOnlineLibraryChanges(value=>events.push(value));f.fail();
  await expect(spotifyProvider.mutations!.subscribeArtist!(id,true)).rejects.toThrow('写入未确认');
  runtime().account();await expect(spotifyProvider.mutations!.subscribeAlbum!(id,true)).rejects.toThrow('账号已改变');
  unsubscribe();expect(events).toHaveLength(0);
 });
 it('waits for the actual refreshed membership instead of adding an optimistic local item',async()=>{
  const f=runtime();f.stale();const events:any[]=[],unsubscribe=subscribeOnlineLibraryChanges(value=>events.push(value));
  await spotifyProvider.mutations!.subscribeAlbum!(id,true);unsubscribe();
  expect(f.calls.filter(c=>c.action==='albums')).toHaveLength(2);expect(events).toHaveLength(1);
 });
 it('a confirmed home snapshot invalidates an older in-flight list and cannot cross accounts',async()=>{
  let finish!:(value:any)=>void;const feed=createFavoriteArtistsFeed({getUserArtists:()=>new Promise(resolve=>{finish=resolve;})});
  const owner={providerId:'spotify',userId:'me'};feed.setOwner(owner);const pending=feed.ensure();
  const row={providerId:'spotify',id,name:'Confirmed artist',type:'artist'};
  feed.replace!(owner,[row]);finish({items:[],hasMore:false,nextOffset:0});await pending;
  expect(feed.getSnapshot().data).toEqual([row]);feed.setOwner({...owner,userId:'other'});feed.replace!(owner,[row]);
  expect(feed.getSnapshot().data).toEqual([]);
 });
 it('rejects a late prior-kind response and keeps songs/artist/album results separate',async()=>{
  let finish!:(value:any)=>void;runtime();const deferred=vi.spyOn(omni,'searchProviderCollections').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const store=useSearchNavigationStore.getState();store.setSearchKind('artists');const old=store.submitSearch({query:'Old artist',sourceTab:'spotify',deps});
  store.setSearchKind('albums');await store.submitSearch({query:'New album',sourceTab:'spotify',deps});
  finish({items:[{providerId:'spotify',id:other,name:'Old',type:'artist'}],hasMore:false,nextOffset:1});await old;deferred.mockRestore();
  expect(useSearchNavigationStore.getState().searchCollections?.[0].type).toBe('album');
 });
 it('restores the correct result kind and its own cached page after returning from a detail',async()=>{
  runtime();const store=useSearchNavigationStore.getState();store.setSearchKind('artists');
  await store.submitSearch({query:'Same query',sourceTab:'spotify',deps});store.setSearchKind('albums');
  await store.submitSearch({query:'Same query',sourceTab:'spotify',deps});
  store.restoreSearch({query:'Same query',sourceTab:'spotify',kind:'artists'});
  expect(useSearchNavigationStore.getState().searchKind).toBe('artists');expect(useSearchNavigationStore.getState().searchCollections?.[0].type).toBe('artist');
 });
});
