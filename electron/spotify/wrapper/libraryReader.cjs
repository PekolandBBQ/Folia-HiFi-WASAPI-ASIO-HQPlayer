(function(root){
  'use strict';
  // Read metadata using the same logged-in client services; never send playback commands.
  function createLibraryReader(spotify,normalize){
    let limited=false;const pending=new Map();
    const locale=()=>spotify.Locale?.getLocale?.()||'en';
    async function query(name,variables,definitions){
      const definition=spotify.GraphQL?.Definitions?.[name]||definitions?.[name];
      if(!definition||typeof spotify.GraphQL?.Request!=='function')throw Error('LIBRARY_QUERY_UNAVAILABLE');
      let result;
      try{result=await spotify.GraphQL.Request(definition,variables);}
      catch(error){
        const status=Number(error?.status??error?.statusCode??error?.response?.status);
        const code=status===429?'LIBRARY_RATE_LIMITED':status===400?'LIBRARY_REQUEST_INVALID':status===401||status===403?'LIBRARY_ACCESS_DENIED':'LIBRARY_QUERY_FAILED';
        throw Object.assign(Error(code),{queryName:name,...(Number.isInteger(status)?{status}:{}),detail:String(error?.message||'Spotify query rejected').slice(0,500)});
      }
      if(result?.errors?.length)throw Object.assign(Error('LIBRARY_QUERY_FAILED'),{queryName:name,detail:result.errors.map(e=>e.message).join('; ').slice(0,500)});
      return result?.data;
    }
    async function contents(kind,offset,limit){
      if(kind==='playlist'&&typeof spotify.Platform.RootlistAPI?.getContents==='function'){
        const root=await spotify.Platform.RootlistAPI.getContents();if(!Array.isArray(root?.items))throw Error('LIBRARY_SCHEMA_INVALID');
        const rows=[];function visit(items){for(const item of items){if(item.type==='folder')visit(item.items||[]);else if(normalize.id(item.uri,'playlist'))rows.push(item);}}
        visit(root.items);return normalize.page({items:rows.slice(offset,offset+limit),totalLength:rows.length},offset,limit,value=>normalize.collection(value,'playlist'));
      }
      const api=spotify.Platform.LibraryAPI;
      if(typeof api?.getContents!=='function'||typeof api.getContentsPrimaryFilterId!=='function')throw Error('LIBRARY_UNAVAILABLE');
      const filter=api.getContentsPrimaryFilterId(kind);if(filter==null)throw Error('LIBRARY_FILTER_UNAVAILABLE');
      const raw=await api.getContents({filters:[filter],offset,limit});
      return normalize.page(raw,offset,limit,value=>normalize.collection(value,kind));
    }
    async function read(args){
      const {operation,id,definitions}=args,offset=Math.max(0,args.offset||0),limit=Math.max(1,Math.min(50,args.limit||50));
      if(operation==='account'){
        const user=await spotify.Platform.UserAPI.getUser();if(!user?.username)throw Error('SPOTIFY_LOGIN_REQUIRED');
        return {id:user.username,display_name:user.displayName||user.username,images:normalize.images(user.images)};
      }
      if(operation==='playlists'||operation==='albums'||operation==='artists')return contents(operation==='playlists'?'playlist':operation==='albums'?'album':'artist',offset,limit);
      if(operation==='searchAlbums'||operation==='searchArtists'){
        const term=String(args.query||'').trim(),kind=operation==='searchArtists'?'artist':'album';
        if(!term)return {items:[],total:0,consumed:0,next:false};
        const data=await query(operation,{searchTerm:term,offset,limit,includePreReleases:false,includeAlbumPreReleases:false,includeAudiobooks:true,includeAuthors:false,includeEpisodeContentRatingsV2:false,numberOfTopResults:20},definitions);
        const raw=kind==='artist'?data?.searchV2?.artists:data?.searchV2?.albumsV2;
        if(!Array.isArray(raw?.items))throw Error('LIBRARY_SCHEMA_INVALID');
        const result=normalize.page(raw,offset,limit,value=>normalize.collection(value,kind));
        const next=raw.pagingInfo?.nextOffset;
        if(Number.isSafeInteger(next)&&next>offset){result.consumed=next-offset;result.next=true;}
        else if(next===null)result.next=false;
        return result;
      }
      if(operation==='subscriptionStatus'){
        const kind=args.collectionType,uri='spotify:'+kind+':'+id;
        if(!['album','artist'].includes(kind)||!normalize.id(uri,kind))throw Error('LIBRARY_ITEM_INVALID');
        const state=await spotify.Platform.LibraryAPI?.contains?.(uri);
        if(!Array.isArray(state)||typeof state[0]!=='boolean')throw Error('LIBRARY_SCHEMA_INVALID');
        return {id,type:kind,subscribed:state[0]};
      }
      if(operation==='playlist'||operation==='playlistTracks'){
        const api=spotify.Platform.PlaylistAPI,uri='spotify:playlist:'+id;
        if(operation==='playlist'){
          if(typeof api?.getMetadata!=='function')throw Error('LIBRARY_UNAVAILABLE');
          const value=await api.getMetadata(uri),result=normalize.collection({...value,uri},'playlist');
          if(!result)throw Error('LIBRARY_SCHEMA_INVALID');return result;
        }
        if(typeof api?.getContents!=='function')throw Error('LIBRARY_UNAVAILABLE');
        return normalize.page(await api.getContents(uri,{offset,limit}),offset,limit,normalize.track);
      }
      if(operation==='album'||operation==='albumTracks'){
        const data=await query(operation==='album'?'getAlbum':'queryAlbumTracks',{uri:'spotify:album:'+id,locale:locale(),offset,limit},definitions);
        const album=data?.albumUnion;
        if(album?.__typename!=='Album')throw Error('LIBRARY_ITEM_UNAVAILABLE');
        if(operation==='album'){const result=normalize.collection(album,'album');if(!result)throw Error('LIBRARY_SCHEMA_INVALID');return result;}
        return normalize.page(album.tracksV2||album.tracks,offset,limit,value=>normalize.track(value,album));
      }
      if(operation==='artist'||operation==='artistSongs'){
        const data=await query('queryArtistOverview',{uri:'spotify:artist:'+id,locale:locale(),preReleaseV2:false},definitions);
        const artist=data?.artistUnion;
        if(artist?.__typename!=='Artist')throw Error('LIBRARY_ITEM_UNAVAILABLE');
        if(operation==='artist'){const result=normalize.collection(artist,'artist');if(!result)throw Error('LIBRARY_SCHEMA_INVALID');return result;}
        const rows=artist.discography?.topTracks?.items;if(!Array.isArray(rows))throw Error('LIBRARY_SCHEMA_INVALID');
        return normalize.page({items:rows.slice(offset,offset+limit),totalCount:rows.length},offset,limit,normalize.track);
      }
      if(operation==='artistAlbums'){
        const data=await query('queryArtistDiscographyAlbums',{uri:'spotify:artist:'+id,offset,limit},definitions),albums=data?.artistUnion?.discography?.albums;
        return normalize.page(albums,offset,limit,entry=>normalize.collection(entry?.releases?.items?.[0]||entry,'album'));
      }
      if(operation==='recommendations'){
        // Match the installed desktop home query, including its required integration identity.
        // The client cookie stays inside Spotify and is never included in bridge diagnostics.
        const cookie=typeof document==='object'?document.cookie||'':'';
        const visitor=cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('sp_t='))?.slice(5)||'';
        const data=await query('home',{homeEndUserIntegration:'INTEGRATION_DESKTOP',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'',sp_t:visitor,facet:'',sectionItemsLimit:10,includeHomeChapterVideoCards:false,includeEpisodeContentRatingsV2:false},definitions);
        return {items:normalize.recommendations(data).slice(0,limit),next:false};
      }
      throw Error('SOURCE_OPERATION_UNSUPPORTED');
    }
    return args=>{
      if(limited)return Promise.reject(Error('LIBRARY_RATE_LIMITED'));
      const key=JSON.stringify([args.operation,args.id,args.collectionType,args.query,args.offset,args.limit]);
      if(!pending.has(key))pending.set(key,read(args).catch(error=>{
        if(error?.status===429||error?.code===429||/\b429\b/.test(error?.message||'')){limited=true;if(error.message==='LIBRARY_RATE_LIMITED')throw error;throw Error('LIBRARY_RATE_LIMITED');}
        throw error;
      }).finally(()=>pending.delete(key)));
      return pending.get(key);
    };
  }
  root.FoliaSpotifyLibraryReader=createLibraryReader;
  if(typeof module==='object')module.exports={createLibraryReader};
})(globalThis);
