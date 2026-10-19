(function(root){
  'use strict';
  // Write through Spotify's own library, then confirm remote state before reporting success.
  function createLibraryMutations(spotify,wait){
    let limited=false;
    return async args=>{
      const {id,collectionType:kind,subscribed}=args,uri='spotify:'+kind+':'+id,api=spotify.Platform.LibraryAPI;
      if(!['album','artist'].includes(kind)||!String(id||'').match(/^[A-Za-z0-9]{22}$/)||typeof subscribed!=='boolean')throw Error('LIBRARY_ITEM_INVALID');
      if(limited)throw Error('LIBRARY_RATE_LIMITED');
      if(typeof api?.contains!=='function'||typeof api?.[subscribed?'add':'remove']!=='function')throw Error('LIBRARY_WRITE_UNAVAILABLE');
      try{
        const account=(await spotify.Platform.UserAPI?.getUser?.())?.username;
        if(!account)throw Error('SPOTIFY_LOGIN_REQUIRED');
        const current=async()=>{if((await spotify.Platform.UserAPI.getUser())?.username!==account)throw Error('LIBRARY_ACCOUNT_CHANGED');};
        const before=await api.contains(uri);await current();
        if(!Array.isArray(before)||typeof before[0]!=='boolean')throw Error('LIBRARY_SCHEMA_INVALID');
        if(before[0]!==subscribed)await api[subscribed?'add':'remove']({uris:[uri]});
        for(let attempt=0;attempt<4;attempt++){
          if(attempt)await wait(attempt*250);
          await current();const state=await api.contains(uri);await current();
          if(Array.isArray(state)&&state[0]===subscribed)return {id,type:kind,subscribed,confirmed:true,accountId:account};
        }
        throw Error('LIBRARY_WRITE_UNCONFIRMED');
      }catch(error){
        if(Number(error?.status??error?.statusCode)===429)limited=true;
        if(limited)throw Error('LIBRARY_RATE_LIMITED');
        if(/^LIBRARY_|^SPOTIFY_LOGIN_REQUIRED$/.test(error.message||''))throw error;
        throw Object.assign(Error('LIBRARY_WRITE_FAILED'),{detail:String(error?.message||'Spotify library write failed').slice(0,500)});
      }
    };
  }
  root.FoliaSpotifyLibraryMutations=createLibraryMutations;
  if(typeof module==='object')module.exports={createLibraryMutations};
})(globalThis);
