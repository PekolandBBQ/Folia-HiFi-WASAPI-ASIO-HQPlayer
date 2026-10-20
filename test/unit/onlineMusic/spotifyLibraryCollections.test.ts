import { afterEach, describe, expect, it, vi } from 'vitest';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import { spotifyActivation } from '@/services/onlineMusic/spotifyActivation';
import { buildOnlineRadioCards, buildOnlinePlaylistCards, onlineCardCollection } from '@/library/core/model/homeCards';
import { createFavoriteArtistsFeed } from '@/library/core/services/onlineHomeFeeds';
import { resolveHomeOnlineSource, resolveHomeTabs } from '@/library/core/model/homeSources';
import type { TFunction } from 'i18next';
// Exercise the provider adapter and shared home model with realistic bridge records.
const id='0123456789012345678901';
const raw=(type:string)=>({id,type,name:'Test '+type,images:[{url:'https://i.scdn.co/image/test'}],metadataSource:'spicetify-local-library',artists:[{id,name:'Artist'}]});
function runtime(value:unknown){spotifyActivation.select();const request=vi.fn(async()=>value);vi.stubGlobal('window',{electron:{spotify:{request}}});return request;}
afterEach(()=>vi.unstubAllGlobals());
describe('Spotify library collections in existing Folia surfaces',()=>{
    it('retains playlist ownership, creator, images and client provenance',async()=>{
        runtime({items:[{...raw('playlist'),isOwned:false,owner:{id:'friend',display_name:'Friend'}}],total:1,next:false,consumed:1});
        const page=await spotifyProvider.library!.getUserPlaylists('me',50,0);
        expect(page.items[0]).toMatchObject({providerId:'spotify',isOwned:false,creator:{nickname:'Friend'},metadataSource:'spicetify-local-library',coverUrl:'https://i.scdn.co/image/test'});
    });
    it('routes saved albums and followed artists to separate actions and preserves artist types',async()=>{
        const request=runtime({items:[raw('artist')],consumed:1,next:false});
        const page=await spotifyProvider.library!.getUserArtists!('me',50,0);expect(page.items[0].type).toBe('artist');
        expect(request).toHaveBeenCalledWith({action:'artists',limit:50,offset:0});
        request.mockResolvedValue({items:[raw('album')],consumed:1,next:false});
        expect((await spotifyProvider.library!.getUserAlbums!('me',50,0)).items[0].artists?.[0].name).toBe('Artist');
    });
    it('album tracks keep the normalized cover and use one paged request',async()=>{
        const song={id,name:'song',durationMs:1000,artists:[],album:{id,name:'album',coverUrl:'https://i.scdn.co/image/song'},sourceRef:{kind:'online',providerId:'spotify',mediaId:id,providerData:{sessionBoundAudio:true}}};
        const request=runtime({items:[song],consumed:1,next:false});
        expect((await spotifyProvider.catalog!.getAlbumTracks!(id,50,0)).items[0].album.coverUrl).toBe(song.album.coverUrl);expect(request).toHaveBeenCalledTimes(1);
    });
    it('recommendation cards retain the original playlists and do not insert unsupported FM/Daily items',async()=>{
        runtime({items:[{...raw('playlist'),name:'Daily Mix 1'}]});
        const recommended=await spotifyProvider.recommendations!.getRecommendedCollections!(35);
        const cards=buildOnlineRadioCards({dailyCoverUrl:'',dailyCount:0,supportsPersonalFm:false,supportsDailySongs:false,recommended},{t:((k:string)=>k) as TFunction});
        expect(cards.map(c=>c.name)).toEqual(['Daily Mix 1']);expect(onlineCardCollection(cards[0])).toMatchObject({id,type:'playlist',providerId:'spotify'});
    });
    it('artist cards open the existing artist surface and the tab only appears for supported providers',()=>{
        const capabilities=spotifyProvider.capabilities;
        const online=resolveHomeOnlineSource({providerId:'spotify',capabilities,fallbackLabel:'Spotify',fallbackUser:null,fallbackPlaylists:[],platformAvailable:true});
        const tabs=resolveHomeTabs({visibility:{playlist:true,albums:true,radio:true,local:true},online,navidromeEnabled:false,localAvailability:{supported:true,reason:null}});
        expect(tabs.map(t=>t.key)).toContain('artists');
        const card=buildOnlinePlaylistCards([{id,providerId:'spotify',name:'Artist',type:'artist'}],((k:string)=>k) as TFunction)[0];
        expect(onlineCardCollection(card)).toMatchObject({type:'artist',providerId:'spotify',id});expect(card.description).toBe('localMusic.artists');
    });
    it('artist pagination shares the existing account generation and discards late old-user results',async()=>{
        let finish!:(value:any)=>void;const getUserArtists=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;}));
        const feed=createFavoriteArtistsFeed({getUserArtists});feed.setOwner({providerId:'spotify',userId:'old'});const pending=feed.ensure();feed.setOwner({providerId:'spotify',userId:'new'});
        finish({items:[{...raw('artist'),providerId:'spotify'}],nextOffset:1,hasMore:false});await pending;
        expect(feed.getSnapshot()).toMatchObject({owner:{userId:'new'},loaded:false,data:[]});
    });
});
