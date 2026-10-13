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
    performance,Date,setTimeout,Spicetify:{CosmosAsync:{get},Player:{},Platform:{LibraryAPI:{getTracks},UserAPI:{getUser:async()=>({username:'test'})},PlayerAPI:{_state:state},ConnectAPI:{getState:()=>({activeDevice:{isLocal:true,connectStateId:'local'}})}}}};
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
