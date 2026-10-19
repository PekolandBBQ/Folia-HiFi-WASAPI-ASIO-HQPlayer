'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const normalize=require('../../electron/spotify/wrapper/libraryNormalize.cjs');
const {createLibraryReader}=require('../../electron/spotify/wrapper/libraryReader.cjs');
const {readLibraryDefinitions}=require('../../electron/spotify/wrapper/libraryDefinitions.cjs');
const {extensionSource}=require('../../electron/spotify/wrapper/extensionSource.cjs');
const {createLibraryService}=require('../../electron/spotify/wrapper/libraryService.cjs');
const {expected}=require('../../electron/spotify/wrapper/handshake.cjs');
// Installed-client response shapes, with transport and player kept under explicit test control.
const id='0123456789012345678901',other='1123456789012345678901';
const image='spotify:image:'+'a'.repeat(40),entry=(type,key=id)=>({type,uri:`spotify:${type}:${key}`,name:type,images:[{url:image}]});
const track={uri:`spotify:track:${id}`,name:'song',duration:{totalMilliseconds:123000},artists:{items:[{profile:{name:'artist'}}]},albumOfTrack:{name:'album',coverArt:{sources:[{url:'https://i.scdn.co/image/cover'}]}}};
const fixture=(Platform={},Request=async()=>({}))=>createLibraryReader({Platform,GraphQL:{Definitions:new Proxy({},{get:(_t,name)=>({name})}),Request},Locale:{getLocale:()=> 'zh-CN'}},normalize);

test('browsing an account does not require this computer to be the active playback device',async()=>{
  const read=fixture({UserAPI:{getUser:async()=>({username:'me',displayName:'Me',images:[{url:'https://i.scdn.co/image/me'}]})},ConnectAPI:{getState:()=>assert.fail('account lookup checked playback device')}});
  assert.equal((await read({operation:'account'})).id,'me');
  await assert.rejects(fixture({UserAPI:{getUser:async()=>null}})({operation:'account'}),/SPOTIFY_LOGIN_REQUIRED/);
});

test('rootlist includes owned and followed playlists inside nested folders and paginates by tracks, not folders',async()=>{
  const read=fixture({RootlistAPI:{getContents:async()=>({items:[{...entry('playlist'),isOwnedBySelf:true,owner:{username:'self',name:'Me'}},{type:'folder',items:[{...entry('playlist',other),isOwnedBySelf:false,owner:{username:'friend'}}]}]})}});
  const first=await read({operation:'playlists',limit:1});assert.equal(first.total,2);assert.equal(first.next,true);assert.equal(first.items[0].isOwned,true);
  const second=await read({operation:'playlists',offset:1,limit:1});assert.equal(second.items[0].id,other);assert.equal(second.items[0].isOwned,false);assert.equal(second.next,false);
});
test('albums and artists use the client-provided filter identity; missing filters do not pretend the library is empty',async()=>{
  const calls=[],read=fixture({LibraryAPI:{getContentsPrimaryFilterId:kind=>'filter:'+kind,getContents:async args=>{calls.push(args);return {items:[entry(args.filters[0].slice(7))],totalLength:1};}}});
  assert.equal((await read({operation:'albums'})).items[0].type,'album');assert.equal((await read({operation:'artists'})).items[0].type,'artist');
  assert.deepEqual(calls.map(c=>c.filters),[['filter:album'],['filter:artist']]);
  await assert.rejects(fixture({LibraryAPI:{getContents:()=>{},getContentsPrimaryFilterId:()=>null}})({operation:'artists'}),/LIBRARY_FILTER_UNAVAILABLE/);
});
test('playlist pages preserve duplicate songs, filter local/episode entries and advance past filtered rows',async()=>{
  const read=fixture({PlaylistAPI:{getContents:async()=>({items:[track,{uri:'spotify:episode:'+id},track],totalLength:7,limit:3})}});
  const page=await read({operation:'playlistTracks',id,limit:3});assert.equal(page.items.length,2);assert.equal(page.consumed,3);assert.equal(page.next,true);assert.equal(page.items[0].durationMs,123000);
});
test('album page supplies album artwork to tracks and retains partial-page totals',async()=>{
  const album={...entry('album'),__typename:'Album',coverArt:{sources:[{url:'https://i.scdn.co/image/album'}]},tracksV2:{items:[{track:{...track,albumOfTrack:undefined}}],totalCount:3}};
  const calls=[],read=fixture({},async(d,v)=>{calls.push([d.name,v]);return {data:{albumUnion:album}};});
  assert.equal((await read({operation:'album',id})).id,id);
  const page=await read({operation:'albumTracks',id,offset:1,limit:1});assert.equal(page.items[0].coverUrl,'https://i.scdn.co/image/album');assert.equal(page.next,true);assert.equal(calls[1][1].offset,1);
});
test('artist details, top songs and release-group albums normalize separately',async()=>{
  const artist={...entry('artist'),__typename:'Artist',profile:{name:'Artist'},discography:{topTracks:{items:[{track}]},albums:{items:[{releases:{items:[entry('album')]}}],totalCount:1}}};
  const read=fixture({},async()=>({data:{artistUnion:artist}}));
  assert.equal((await read({operation:'artist',id})).type,'artist');assert.equal((await read({operation:'artistSongs',id})).items[0].id,id);assert.equal((await read({operation:'artistAlbums',id})).items[0].type,'album');
});
test('real recommendation section wrappers yield playlists, deduplicate repeated shelves and exclude DJ',async()=>{
  const weekly={...entry('playlist'),name:'每週新發現'},mix={...entry('playlist',other),name:'Daily Mix 1'};
  const read=fixture({},async()=>({data:{home:{sectionContainer:{sections:{items:[{sectionItems:{items:[{content:{data:weekly}},{content:{data:mix}},{content:{data:{uri:'spotify:app:enhanced-context',name:'DJ'}}}]}},{sectionItems:{items:[{content:{data:weekly}}]}}]}}}}}));
  assert.deepEqual((await read({operation:'recommendations'})).items.map(i=>i.name),['每週新發現','Daily Mix 1']);
});

test('recommendations match the desktop home request and keep the visitor cookie inside Spotify',async()=>{
  const context={document:{cookie:'other=value; sp_t=client-visitor; tail=value'},Intl};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../electron/spotify/wrapper/libraryReader.cjs'),'utf8'),context);
  let calls=0;
  const read=context.FoliaSpotifyLibraryReader({Platform:{},GraphQL:{Definitions:{home:{name:'home'}},Request:async(definition,variables)=>{
    calls++;assert.equal(definition.name,'home');
    assert.equal(variables.homeEndUserIntegration,'INTEGRATION_DESKTOP');assert.equal(variables.sectionItemsLimit,10);
    assert.equal(variables.sp_t,'client-visitor');assert.equal(variables.facet,'');
    assert.equal(variables.includeHomeChapterVideoCards,false);assert.equal(variables.includeEpisodeContentRatingsV2,false);
    assert.equal(variables.timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
    return {data:{home:{sectionContainer:{sections:{items:[{sectionItems:{items:[{content:{data:entry('playlist')}}]}}]}}}}};
  }}},normalize);
  const result=await read({operation:'recommendations'});assert.equal(calls,1);assert.equal(result.items[0].id,id);
  assert.equal(JSON.stringify(result).includes('client-visitor'),false);
});

test('query rejection retains the query identity, status and original reason; a later read can recover',async()=>{
  let calls=0;const read=fixture({},async()=>{
    if(++calls===1)throw Object.assign(Error('Missing required variable homeEndUserIntegration'),{status:400});
    return {data:{home:{sectionContainer:{sections:{items:[]}}}}};
  });
  await assert.rejects(read({operation:'recommendations'}),error=>{
    assert.equal(error.message,'LIBRARY_REQUEST_INVALID');assert.equal(error.status,400);assert.equal(error.queryName,'home');
    assert.match(error.detail,/homeEndUserIntegration/);return true;
  });
  assert.deepEqual((await read({operation:'recommendations'})).items,[]);assert.equal(calls,2);
  await assert.rejects(fixture({},async()=>({errors:[{message:'Invalid recommendation facet'}]}))({operation:'recommendations'}),error=>{
    assert.equal(error.message,'LIBRARY_QUERY_FAILED');assert.equal(error.queryName,'home');assert.match(error.detail,/facet/);return true;
  });
});

test('recommendation rate limits preserve the first reason and do not issue another query',async()=>{
  let calls=0;const read=fixture({},async()=>{calls++;throw Object.assign(Error('Too many home requests'),{status:429});});
  await assert.rejects(read({operation:'recommendations'}),error=>{assert.equal(error.message,'LIBRARY_RATE_LIMITED');assert.equal(error.queryName,'home');assert.equal(error.detail,'Too many home requests');return true;});
  await assert.rejects(read({operation:'recommendations'}),/LIBRARY_RATE_LIMITED/);assert.equal(calls,1);
});

test('recommendation query errors do not claim playback or connection was rejected',()=>{
  const {failureDetails}=require('../../electron/spotify/failureDetails.cjs');
  const result=failureDetails({code:'CONTROL_REJECTED'},'recommendations');
  assert.match(result.detail,/推荐歌单/);assert.doesNotMatch(result.detail,/播放控制|拒绝.*连接|CONTROL_REJECTED/);
  assert.match(failureDetails({code:'LIBRARY_REQUEST_INVALID'},'recommendations').detail,/查询.*参数/);
});
test('missing recommendation schema fails explicitly rather than returning an empty success',async()=>{
  await assert.rejects(fixture({},async()=>({data:{home:null}}))({operation:'recommendations'}),/RECOMMENDATIONS_SCHEMA_INVALID/);
});
test('metadata failures can retry; 429 stops subsequent library requests',async()=>{
  let count=0;const read=fixture({LibraryAPI:{getContentsPrimaryFilterId:()=> 'x',getContents:async()=>{if(++count===1)throw Error('temporary');return {items:[],totalLength:0};}}});
  await assert.rejects(read({operation:'albums'}),/temporary/);await read({operation:'albums'});assert.equal(count,2);
  let limited=0;const rate=fixture({RootlistAPI:{getContents:async()=>{limited++;throw {status:429};}}});
  await assert.rejects(rate({operation:'playlists'}),/LIBRARY_RATE_LIMITED/);await assert.rejects(rate({operation:'playlists'}),/LIBRARY_RATE_LIMITED/);assert.equal(limited,1);
});
test('concurrent metadata reads share their request without a player pause, select or seek',async()=>{
  let finish,calls=0;const read=fixture({LibraryAPI:{getContentsPrimaryFilterId:()=> 'x',getContents:()=>{calls++;return new Promise(r=>{finish=r;});}},PlayerAPI:new Proxy({},{get:()=>assert.fail('library read touched player')})});
  const a=read({operation:'albums'}),b=read({operation:'albums'});assert.equal(calls,1);finish({items:[],totalLength:0});await Promise.all([a,b]);
});
test('query identities come from current resource files and refresh after a changed client asset',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'folia-library-queries-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'xpui'));
  const file=path.join(root,'xpui/xpui-modules.js');fs.writeFileSync(file,'new q.l("getAlbum","query","'+'a'.repeat(64)+'",null)');
  assert.equal(readLibraryDefinitions(root).getAlbum.sha256Hash,'a'.repeat(64));fs.writeFileSync(file,'new q.l("getAlbum","query","'+'b'.repeat(64)+'",null)');fs.utimesSync(file,new Date(),new Date(Date.now()+1000));assert.equal(readLibraryDefinitions(root).getAlbum.sha256Hash,'b'.repeat(64));
});
test('composed extension advertises library capability and metadata does not block a snapshot',async()=>{
  let socket;const replies=[],context={document:{createElement:()=>({style:{}}),body:{append(){}}},WebSocket:class{constructor(){socket=this;this.readyState=1;}send(v){replies.push(JSON.parse(v));}},performance,Date,Intl,setTimeout,clearTimeout,Spicetify:{Platform:{RootlistAPI:{getContents:()=>new Promise(()=>{})},UserAPI:{getUser:async()=>({username:'me'})},ConnectAPI:{getState:()=>({activeDevice:{isLocal:true,connectStateId:'local'}})},PlayerAPI:{_state:{}}},Player:{}}};
  vm.runInNewContext(extensionSource('ws://test'),context);socket.onmessage({data:JSON.stringify({id:1,op:'hello',args:{}})});socket.onmessage({data:JSON.stringify({id:2,op:'libraryRead',args:{operation:'playlists'}})});socket.onmessage({data:JSON.stringify({id:3,op:'snapshot',args:{}})});await new Promise(setImmediate);
  assert.ok(replies.find(v=>v.id===1).value.capabilities.includes('libraryCollections'));assert.equal(replies.find(v=>v.id===3).ok,true);assert.equal(replies.some(v=>v.id===2),false);
});

test('composed extension reports recommendation query details without converting them into control errors',async()=>{
  let socket;const replies=[],context={document:{createElement:()=>({style:{}}),body:{append(){}}},WebSocket:class{constructor(){socket=this;this.readyState=1;}send(v){replies.push(JSON.parse(v));}},performance,Date,Intl,setTimeout,clearTimeout,Spicetify:{Platform:{},GraphQL:{Definitions:{home:{}},Request:async()=>{throw Object.assign(Error('Missing required variable: homeEndUserIntegration'),{status:400});}},Player:{}}};
  vm.runInNewContext(extensionSource('ws://test'),context);
  socket.onmessage({data:JSON.stringify({id:1,op:'libraryRead',args:{operation:'recommendations'}})});await new Promise(setImmediate);
  const result=replies[0];assert.equal(result.ok,false);assert.equal(result.code,'LIBRARY_REQUEST_INVALID');
  assert.equal(result.diagnostic.operation,'recommendations');assert.equal(result.diagnostic.queryName,'home');assert.equal(result.diagnostic.upstreamStatus,400);
  assert.match(result.diagnostic.message,/homeEndUserIntegration/);
});
test('virtual queue does not skip the first real playlist at a page boundary and tracks enter the existing catalog',async()=>{
  const calls=[],catalog=new Map(),service=createLibraryService({bridge:{request:async(op,args)=>{if(op==='hello')return expected;calls.push(args);return {items:args.operation==='playlistTracks'?[normalize.track(track)]:[normalize.collection(entry('playlist'))],consumed:1,total:2,next:true};}},catalog,song:t=>({id:t.id}),connect:async()=>{},ready:Promise.resolve(),apps:()=>os.tmpdir(),log:()=>{}});
  const first=await service.request({action:'playlists',limit:2});assert.equal(first.items[0].id,'folia-local-queue');assert.equal(first.consumed,2);
  await service.request({action:'playlists',offset:2,limit:2});assert.equal(calls[1].offset,1);
  await service.request({action:'playlistTracks',id});assert.ok(catalog.has(id));assert.equal(service.handles({action:'playlistTracks',id:'folia-local-queue'}),false);
});
