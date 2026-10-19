'use strict';
const {readLibraryDefinitions}=require('./libraryDefinitions.cjs');
const {requireHandshake}=require('./handshake.cjs');
// Keep local queue and liked-song identities intact; real collections use Spotify IDs.
const actions=new Set(['status','playlists','albums','artists','recommendations','playlist','playlistTracks','album','albumTracks','artist','artistSongs','artistAlbums','searchArtists','searchAlbums','subscriptionStatus','subscribeCollection']);
function createLibraryService({bridge,catalog,song,connect,ready,apps,log}){
  return {handles:input=>actions.has(input.action)&&input.id!=='folia-local-queue',
    async request(input,progress){
      await ready;await connect(progress);await requireHandshake(bridge);
      const offset=input.offset||0,limit=input.limit||50,virtual=input.action==='playlists';
      const definitions=['album','albumTracks','artist','artistSongs','artistAlbums','recommendations','searchArtists','searchAlbums'].includes(input.action)?readLibraryDefinitions(apps()):undefined;
      const result=virtual&&offset===0&&limit===1?{items:[],consumed:0,next:true}:await bridge.request(input.action==='subscribeCollection'?'setCollectionSubscription':'libraryRead',{operation:input.action==='status'?'account':input.action,id:input.id,query:input.query,collectionType:input.collectionType,subscribed:input.subscribed,offset:virtual?Math.max(0,offset-1):offset,limit:virtual&&offset===0?limit-1:limit,definitions});
      if(input.action==='subscribeCollection'&&(result?.confirmed!==true||result.id!==input.id||result.type!==input.collectionType||result.subscribed!==input.subscribed))throw Object.assign(Error('LIBRARY_WRITE_UNCONFIRMED'),{code:'LIBRARY_WRITE_UNCONFIRMED'});
      if(virtual){if(Number.isSafeInteger(result.total))result.total++;if(offset===0){result.items.unshift({id:'folia-local-queue',providerId:'spotify',name:'本机 Spotify 已加载曲目',description:'当前曲目与本机队列',type:'playlist',providerData:{localQueue:true}});result.consumed=(result.consumed??result.items.length-1)+1;}}
      const tracks=['playlistTracks','albumTracks','artistSongs'].includes(input.action);
      if(tracks){for(const track of result.items)catalog.set(track.id,track);result.items=result.items.map(song);result.preserveDuplicates=true;}
      log('ui-library-read',{operation:input.action,collectionId:input.id,collectionType:input.collectionType,subscribed:result.subscribed,confirmed:result.confirmed,offset:input.offset||0,count:result.items?.length,total:result.total,consumed:result.consumed,hasMore:Boolean(result.next)});
      return result;
    }};
}
module.exports={createLibraryService};
