'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
// Run the extension protocol with controlled I/O, without connecting to Spotify.
function fixture(get,getTracks=async()=>({items:[],totalLength:0,limit:0})){
  let ws;const replies=[];
  const state={item:{uri:'spotify:track:0123456789012345678901'},timestamp:Date.now(),duration:90000,positionAsOfTimestamp:100,isPaused:true};
  const context={document:{createElement:()=>({style:{}}),body:{append(){}}},WebSocket:class{constructor(){ws=this;this.readyState=1;}send(value){replies.push(JSON.parse(value));}},
    performance,Date,setTimeout,clearTimeout,Spicetify:{CosmosAsync:{get},Player:{},Platform:{LibraryAPI:{getTracks},UserAPI:{getUser:async()=>({username:'test'})},PlayerAPI:{_state:state},ConnectAPI:{getState:()=>({activeDevice:{isLocal:true,connectStateId:'local'}})}}}};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../electron/spotify/wrapper/extension.js'),'utf8').replace('__FOLIA_LIVE_URL__',JSON.stringify('ws://test')),context);
  return {context,replies,request:(id,op,args={})=>ws.onmessage({data:JSON.stringify({id,op,args})})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('cold Wrapper uses the upstream origin getter before UI-module discovery and keeps Wrapper command dispatch',async()=>{
  const f=fixture(async()=>({})),s=f.context.Spicetify;let wrapperCalls=0,platformCalls=0;
  s.Platform.PlayerAPI.play=async()=>platformCalls++;
  s.Player.playUri=async()=>{wrapperCalls++;await s.Player.origin.play();};
  for(const name of ['pause','play','seek'])s.Player[name]=()=>{};
  assert.equal(s.Player.origin,undefined);
  f.request(1,'snapshot');await tick();
  assert.equal(f.replies[0].value.wrapperReady,true);
  assert.equal(s.Player.origin,s.Platform.PlayerAPI);
  f.request(2,'command',{path:'wrapper',operation:'select',account:'test',deviceId:'local',trackId:'0123456789012345678901'});await tick();
  assert.equal(f.replies.find(r=>r.id===2).ok,true);assert.equal(wrapperCalls,1);assert.equal(platformCalls,1);
  const replacement={...s.Platform.PlayerAPI};s.Platform.PlayerAPI=replacement;
  assert.equal(s.Player.origin,replacement);
});
test('slow lyrics do not hold snapshot/control queue and duplicate requests share fetch',async()=>{
  let finish,calls=0;const f=fixture(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const args={trackId:'0123456789012345678901',imageUrl:'https://i.scdn.co/image/test'};
  f.request(1,'lyrics',args);f.request(2,'lyrics',args);f.request(3,'snapshot');await tick();
  assert.equal(calls,1);assert.equal(f.replies[0].id,3);
  finish({lyrics:{syncType:'LINE_SYNCED',lines:[{startTimeMs:'100',words:'test'}]}});await tick();
  assert.equal(f.replies.filter(r=>r.value?.source==='spotify-native').length,2);
});
test('429 stops subsequent lyrics requests without retry',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw {status:429};});
  f.request(1,'lyrics',{trackId:'0123456789012345678901'});await tick();
  f.request(2,'lyrics',{trackId:'1123456789012345678901'});await tick();
  assert.equal(calls,1);assert.ok(f.replies.every(r=>r.code==='LYRICS_RATE_LIMITED'));
});
test('liked tracks convert native artwork and consume raw range when total is unknown',async()=>{
  const f=fixture(async()=>({}),async()=>({items:[{uri:'spotify:track:0123456789012345678901',name:'fixture',artists:[],
    duration:{milliseconds:1000},album:{images:[{url:'spotify:image:'+'a'.repeat(40)}]}}],totalLength:0,limit:50}));
  f.request(1,'likedTracks',{offset:0,limit:50});await tick();
  const page=f.replies[0].value;
  assert.equal(page.items[0].coverUrl,'https://i.scdn.co/image/'+'a'.repeat(40));
  assert.equal(page.consumed,50);assert.equal(page.total,undefined);assert.equal(page.next,'local-next');
});
test('slow liked metadata does not block source reads and 429 is not retried',async()=>{
  let fail,calls=0;const f=fixture(async()=>({}),()=>{calls++;return new Promise((_resolve,reject)=>{fail=reject;});});
  f.request(1,'likedTracks');f.request(2,'snapshot');await tick();
  assert.equal(f.replies[0].id,2);fail({status:429});await tick();
  f.request(3,'likedTracks');await tick();assert.equal(calls,1);
  assert.equal(f.replies.find(r=>r.id===3).code,'LIBRARY_RATE_LIMITED');
});

test('transient lyric failure is evicted so the same song can recover',async()=>{
 let calls=0;const f=fixture(async()=>{if(++calls===1)throw {status:503};return {lyrics:{syncType:'LINE_SYNCED',lines:[{startTimeMs:'0',words:'recovered'}]}};});
 const args={trackId:'0123456789012345678901'};
 f.request(1,'lyrics',args);await tick();assert.equal(f.replies[0].code,'LYRICS_UNAVAILABLE');
 f.request(2,'lyrics',args);await tick();assert.equal(calls,2);assert.equal(f.replies[1].value.lines[0].words,'recovered');
});

// Observed track IDs: each must recover independently of any earlier negative response.
for(const [title,trackId] of [['Paper Plane','6nZlSXP6aqHUU7SJpYQzIC'],['In Moments Does Moon Persist','0SalvDj3mS5mOqsQsPFpnV'],['赴大荒','19rMrCvCTdATwQVMNvromq']]){
 for(const reason of ['http-not-found','missing-lyrics','invalid-lines','empty-lines','blank-lines']){
  test(title+': '+reason+' remains distinguishable and is not cached',async()=>{
   let calls=0;const f=fixture(async()=>{if(++calls>1)return {lyrics:{syncType:'LINE_SYNCED',lines:[{startTimeMs:'0',words:'recovered'}]}};
    if(reason==='http-not-found')throw {status:404};
    if(reason==='missing-lyrics')return {};
    if(reason==='invalid-lines')return {lyrics:{lines:{}}};
    return {lyrics:{lines:reason==='blank-lines'?[{words:'   '},null]:[]}};
   });
   f.request(1,'lyrics',{trackId});await tick();assert.equal(f.replies[0].value.reason,reason);
   assert.equal(f.replies[0].value.lines.length,0);
   f.request(2,'lyrics',{trackId});await tick();assert.equal(calls,2);assert.equal(f.replies[1].value.lines[0].words,'recovered');
   f.request(3,'lyrics',{trackId});await tick();assert.equal(calls,2);assert.equal(f.replies[2].value.cacheHit,true);
  });
 }
}
test('HTTP authorization failures are not mislabeled as empty lyrics',async()=>{
 for(const [status,code] of [[401,'LYRICS_AUTH_REQUIRED'],[403,'LYRICS_ACCESS_DENIED']]){
  const f=fixture(async()=>{throw {status};});f.request(1,'lyrics',{trackId:'6nZlSXP6aqHUU7SJpYQzIC'});await tick();assert.equal(f.replies[0].code,code);
 }
});

test('catalog search uses native query, preserves cursor and returns songs outside saved tracks',async()=>{
 const f=fixture(async()=>({}));let variables;
 f.context.Spicetify.GraphQL={Request:async(_definition,args)=>{variables=args;return {data:{searchV2:{tracksV2:{totalCount:90,pagingInfo:{nextOffset:50},items:[{item:{data:{uri:'spotify:track:1123456789012345678901',name:'Online only',duration:{totalMilliseconds:123000},artists:{items:[{profile:{name:'Artist'}}]},albumOfTrack:{name:'Album',coverArt:{sources:[{url:'https://i.scdn.co/test'}]}}}}}]}}}};}};
 f.request(1,'searchTracks',{query:'online',offset:0,limit:50,definition:{name:'searchTracks',sha256Hash:'a'.repeat(64)}});await tick();
 const value=f.replies[0].value;assert.equal(variables.searchTerm,'online');assert.equal(value.items[0].name,'Online only');assert.equal(value.items[0].durationMs,123000);assert.equal(value.consumed,50);assert.equal(value.next,'50');
});
test('slow online search does not block snapshot and missing API never returns local matches',async()=>{
 const f=fixture(async()=>({}));f.request(1,'searchTracks',{query:'song'});await tick();assert.equal(f.replies[0].code,'SEARCH_API_UNAVAILABLE');
 let finish;f.context.Spicetify.GraphQL={Definitions:{searchTracks:{name:'searchTracks',sha256Hash:'a'.repeat(64)}},Request:()=>new Promise(resolve=>{finish=resolve;})};
 f.request(2,'searchTracks',{query:'song'});f.request(3,'snapshot');await tick();assert.equal(f.replies.at(-1).id,3);
 finish({data:{searchV2:{tracksV2:{items:[],totalCount:0,pagingInfo:{nextOffset:null}}}}});await tick();assert.equal(f.replies.at(-1).value.total,0);
});
test('search throttling is not retried',async()=>{
 const f=fixture(async()=>({}));let calls=0;f.context.Spicetify.GraphQL={Definitions:{searchTracks:{name:'searchTracks',sha256Hash:'a'.repeat(64)}},Request:async()=>{calls++;throw {status:429};}};
 f.request(1,'searchTracks',{query:'one'});await tick();f.request(2,'searchTracks',{query:'two'});await tick();assert.equal(calls,1);assert.ok(f.replies.every(r=>r.code==='SEARCH_RATE_LIMITED'));
});
test('like and unlike perform remote writes and confirm state before success',async()=>{
 const f=fixture(async()=>({})),api=f.context.Spicetify.Platform.LibraryAPI;let liked=false;const writes=[];
 api.contains=async()=>[liked];api.add=async arg=>{writes.push(arg.uris[0]);liked=true;};api.remove=async arg=>{writes.push(arg.uris[0]);liked=false;};
 f.request(1,'setLiked',{trackId:'0123456789012345678901',liked:true});await tick();assert.equal(f.replies[0].value.confirmed,true);
 f.request(2,'setLiked',{trackId:'0123456789012345678901',liked:true});await tick();assert.equal(writes.length,1);
 f.request(3,'setLiked',{trackId:'0123456789012345678901',liked:false});await tick();assert.equal(writes.length,2);assert.equal(f.replies.at(-1).value.liked,false);
});
test('failed like recovers on next request and delayed write leaves playback reads free',async()=>{
 const f=fixture(async()=>({})),api=f.context.Spicetify.Platform.LibraryAPI;let liked=false,finish;
 api.contains=async()=>[liked];api.add=async()=>{throw Error('network');};
 f.request(1,'setLiked',{trackId:'0123456789012345678901',liked:true});await tick();assert.equal(f.replies[0].code,'LIBRARY_WRITE_FAILED');
 api.add=()=>new Promise(resolve=>{finish=()=>{liked=true;resolve();};});
 f.request(2,'setLiked',{trackId:'0123456789012345678901',liked:true});f.request(3,'snapshot');await tick();assert.equal(f.replies.at(-1).id,3);
 finish();await tick();assert.equal(f.replies.at(-1).value.confirmed,true);
});
test('fulfilled write without matching readback never reports success',async()=>{
 const f=fixture(async()=>({})),api=f.context.Spicetify.Platform.LibraryAPI;let calls=0;
 f.context.setTimeout=fn=>{fn();};api.contains=async()=>[false];api.add=async()=>{calls++;};
 f.request(1,'setLiked',{trackId:'0123456789012345678901',liked:true});await tick();assert.equal(calls,1);assert.equal(f.replies[0].code,'LIBRARY_WRITE_UNCONFIRMED');
});

test('handshake describes actual loaded code even without player state',async()=>{
 const f=fixture(async()=>({}));delete f.context.Spicetify.Platform.PlayerAPI;
 f.request(1,'hello');await tick();assert.equal(f.replies[0].ok,true);
 const {expected}=require('../electron/spotify/wrapper/handshake.cjs');
 assert.deepEqual(f.replies[0].value,expected);
});

test('hung playback leaves hello, snapshot and online search responsive; timeout releases next command',async()=>{
 const f=fixture(async()=>({})),s=f.context.Spicetify;let expire,calls=0;
 f.context.setTimeout=(fn,ms)=>{assert.ok(ms>0&&ms<=8000);expire=fn;return 1;};f.context.clearTimeout=()=>{};
 for(const name of ['playUri','play','seek'])s.Player[name]=async()=>{};
 s.Player.pause=()=>{calls++;return calls===1?new Promise(()=>{}):Promise.resolve();};
 s.GraphQL={Request:async()=>({data:{searchV2:{tracksV2:{items:[],totalCount:0}}}}),Definitions:{searchTracks:{name:'searchTracks',sha256Hash:'a'.repeat(64)}}};
 const args={path:'wrapper',operation:'pause',account:'test',deviceId:'local'};
 f.request(1,'command',args);await tick();
 f.request(2,'hello');f.request(3,'snapshot');f.request(4,'searchTracks',{query:'test'});await tick();
 for(const id of [2,3,4])assert.equal(f.replies.find(r=>r.id===id)?.ok,true);
 expire();await tick();assert.equal(f.replies.find(r=>r.id===1).code,'BRIDGE_COMMAND_TIMEOUT');
 f.request(5,'command',args);await tick();assert.equal(f.replies.find(r=>r.id===5).ok,true);assert.equal(calls,2);
});
test('late seek completion cannot resume playback after the command expires',async()=>{
 const f=fixture(async()=>({})),s=f.context.Spicetify;let expire,finish,plays=0;
 f.context.setTimeout=(fn)=>{expire=fn;return 1;};f.context.clearTimeout=()=>{};
 s.Player.playUri=async()=>{};s.Player.pause=async()=>{};s.Player.play=async()=>{plays++;};
 s.Player.seek=()=>new Promise(resolve=>{finish=resolve;});
 f.request(1,'command',{path:'wrapper',operation:'play-at-position',positionMs:100,account:'test',deviceId:'local'});await tick();
 expire();await tick();finish();await tick();assert.equal(plays,0);assert.equal(f.replies.length,1);
});

test('account snapshot returns the current Spotify display name and profile images',async()=>{
 const f=fixture(async()=>({}));f.context.Spicetify.Platform.UserAPI.getUser=async()=>({username:'account-id',displayName:'测试用户',images:[{url:'https://example.com/avatar.jpg',width:300,height:300}]});
 f.request(1,'snapshot');await tick();assert.equal(f.replies[0].value.account,'account-id');assert.equal(f.replies[0].value.displayName,'测试用户');assert.equal(f.replies[0].value.images[0].url,'https://example.com/avatar.jpg');
 f.context.Spicetify.Platform.UserAPI.getUser=async()=>({username:'other-id'});f.request(2,'snapshot');await tick();assert.equal(f.replies[1].value.displayName,'other-id');assert.deepEqual(f.replies[1].value.images,[]);
});

for (const [index,mode] of ['off','all','one'].entries()) {
 test('repeat '+mode+' reads and writes the actual Wrapper mode',async()=>{
  const f=fixture(async()=>({}));let actual=index;
  f.context.Spicetify.Player.getRepeat=()=>actual;
  f.context.Spicetify.Player.setRepeat=async value=>{actual=value;};
  f.request(1,'repeatMode');await tick();assert.equal(f.replies[0].value.mode,mode);
  f.request(2,'repeatMode',{mode:['all','one','off'][index]});await tick();
  assert.equal(f.replies[1].ok,true);assert.equal(actual,(index+1)%3);
 });
}
test('unconfirmed repeat write does not report success',async()=>{
 const f=fixture(async()=>({}));f.context.Spicetify.Player.getRepeat=()=>0;
 f.context.Spicetify.Player.setRepeat=async()=>{};
 f.context.setTimeout=fn=>setTimeout(fn,0);
 f.request(1,'repeatMode',{mode:'one'});
 while(!f.replies.length)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.replies[0].code,'REPEAT_MODE_UNCONFIRMED');
});
