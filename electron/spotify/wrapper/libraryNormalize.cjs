(function(root){
  'use strict';
  // Project the installed client's library and GraphQL entities into bounded bridge records.
  const id=(uri,kind)=>new RegExp('^spotify:'+kind+':([A-Za-z0-9]{22})$').exec(uri||'')?.[1];
  const list=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
  const unwrap=value=>value?.item?.data||value?.content?.data||value?.data||value?.item||value;
  function images(value){
    const rows=list(value).flatMap(i=>i?.sources||i?.items||[i]).flat();
    return rows.map(i=>typeof i==='string'?{url:i}:i).filter(i=>typeof i?.url==='string').map(i=>({...i,url:/^spotify:image:[a-f0-9]{40}$/.test(i.url)?'https://i.scdn.co/image/'+i.url.slice(14):i.url})).filter(i=>i.url.startsWith('https://'));
  }
  function collection(entry,kind){
    const v=unwrap(entry);if(!v)return null;
    kind=kind||(/^spotify:(playlist|album|artist):/.exec(v.uri||'')?.[1]);
    const key=id(v.uri,kind);if(!key)return null;
    const name=v.name||v.profile?.name;if(typeof name!=='string'||!name)return null;
    const owner=v.ownerV2?.data||v.owner||{},ownerId=owner.username||owner.id||owner.uri?.split(':').pop();
    const owned=v.isOwnedBySelf??v.isOwned;
    const count=v.totalLength??v.tracksV2?.totalCount??v.tracks?.totalCount??v.tracks?.total??v.total_tracks;
    return {id:key,name,type:kind,uri:v.uri,images:images(v.images||v.coverArt?.sources||v.visuals?.avatarImage?.sources),
      description:v.description||v.profile?.biography?.text||'',
      ...(Number.isSafeInteger(count)&&count>=0?{total_tracks:count}:{}),
      ...(typeof owned==='boolean'?{isOwned:owned}:{}),
      ...(ownerId?{owner:{id:ownerId,display_name:owner.name||owner.displayName||ownerId}}:{}),
      artists:list(v.artists).map(unwrap).filter(Boolean).map(a=>({id:id(a.uri,'artist')||'',name:a.name||a.profile?.name||''})),
      metadataSource:'spicetify-local-library'};
  }
  function track(entry,album){
    const v=entry?.track||unwrap(entry),key=id(v?.uri,'track');if(!key||typeof v.name!=='string')return null;
    const recordAlbum=v.albumOfTrack||v.album||album||{};
    const duration=v.duration?.totalMilliseconds??v.duration?.milliseconds??v.durationMs??v.duration_ms;
    if(!Number.isFinite(duration)||duration<=0)return null;
    return {id:key,name:v.name,durationMs:duration,
      artist:list(v.artists).map(unwrap).filter(Boolean).map(a=>a.name||a.profile?.name||'').join(' / '),
      album:recordAlbum.name||'',coverUrl:images(recordAlbum.coverArt?.sources||recordAlbum.images)[0]?.url};
  }
  function page(raw,offset,limit,normalize){
    if(!Array.isArray(raw?.items))throw Error('LIBRARY_SCHEMA_INVALID');
    const consumed=Number.isSafeInteger(raw.limit)&&raw.limit>=raw.items.length?raw.limit:raw.items.length;
    const total=raw.totalLength??raw.totalCount??raw.total;
    const end=offset+consumed;
    return {items:raw.items.map(normalize).filter(Boolean),consumed,
      ...(Number.isSafeInteger(total)&&total>=0?{total}:{}),
      next:Number.isSafeInteger(total)?end<total:consumed===limit};
  }
  function recommendations(data){
    const sections=data?.home?.sectionContainer?.sections?.items||data?.browse?.sections?.items||data?.homeSections?.sections;
    if(!Array.isArray(sections))throw Error('RECOMMENDATIONS_SCHEMA_INVALID');
    const items=new Map();
    for(const section of sections)for(const item of list(section.sectionItems)){
      const result=collection(item,'playlist');if(result)items.set(result.id,result);
    }
    return [...items.values()];
  }
  root.FoliaSpotifyLibraryNormalize={id,list,unwrap,images,collection,track,page,recommendations};
  if(typeof module==='object')module.exports=root.FoliaSpotifyLibraryNormalize;
})(globalThis);
