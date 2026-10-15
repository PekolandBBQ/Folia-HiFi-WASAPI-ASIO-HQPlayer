const {test}=require('node:test');
const assert=require('node:assert/strict');
const {requestNativeLyrics}=require('../electron/spotify/wrapper/lyrics.cjs');
// No Spotify account/network: transient and permanent outcomes are scripted.
test('timeout then successful same-song reply is delivered with retry diagnostics',async()=>{
 let calls=0;const events=[];
 const result=await requestNativeLyrics({request:async()=>{if(++calls<3)throw Object.assign(Error(),{code:'CONTROL_TIMEOUT'});return {lines:[{words:'ok'}]};}},
 {trackId:'test'},(event,data)=>events.push({event,...data}),async()=>{});
 assert.equal(calls,3);assert.equal(result.lines.length,1);assert.equal(events.at(-1).outcome,'received');
});
test('429 never retries; transient errors stop after three retries',async()=>{
 for(const code of ['LYRICS_RATE_LIMITED','LYRICS_UNAVAILABLE']){
  let calls=0;
  await assert.rejects(requestNativeLyrics({request:async()=>{calls++;throw Object.assign(Error(code),{code});}},
   {trackId:'test'},()=>{},async()=>{}));
  assert.equal(calls,code==='LYRICS_RATE_LIMITED'?1:4);
 }
});

test('bridge accepts lyrics after the control deadline while controls retain their deadline',async t=>{
 const {createBridge}=require('../electron/spotify/wrapper/bridge.cjs');
 const {WebSocket}=require('ws');const bridge=createBridge(()=>{},{port:0});
 const {url}=await bridge.start();const client=new WebSocket(url,{origin:'https://xpui.app.spotify.com'});
 await new Promise((yes,no)=>{client.once('open',yes);client.once('error',no);});
 const messages=[];client.on('message',value=>messages.push(JSON.parse(String(value))));
 t.mock.timers.enable({apis:['setTimeout']});
 try {
  let settled=false;const result=bridge.request('lyrics',{trackId:'test'}).then(v=>{settled=true;return v;});
  await new Promise(setImmediate);await new Promise(setImmediate);
  t.mock.timers.tick(11000);await new Promise(setImmediate);assert.equal(settled,false);
  client.send(JSON.stringify({id:messages[0].id,ok:true,value:{lines:[{words:'late'}]}}));
  assert.equal((await result).lines[0].words,'late');
  const control=bridge.request('snapshot');const failure=assert.rejects(control,{code:'CONTROL_TIMEOUT'});
  t.mock.timers.tick(10001);await failure;
 }finally{t.mock.timers.reset();client.terminate();bridge.close();}
});

test('uncertain empty response silently recovers and records the concrete reason',async()=>{
 const events=[];let calls=0;
 const result=await requestNativeLyrics({request:async()=>++calls===1?{lines:[],reason:'missing-lyrics'}:{lines:[{words:'ok'}],reason:'received'}},
 {trackId:'6nZlSXP6aqHUU7SJpYQzIC'},(event,data)=>events.push(data),async()=>{});
 assert.equal(calls,2);assert.equal(result.lines.length,1);assert.equal(events[0].reason,'missing-lyrics');assert.match(events[0].reasonText,/缺少歌词对象/);
});
test('persistent uncertain empties stop after three retries without throwing a playback failure',async()=>{
 let calls=0;const result=await requestNativeLyrics({request:async()=>{calls++;return {lines:[],reason:'empty-lines'};}},
 {trackId:'19rMrCvCTdATwQVMNvromq'},()=>{},async()=>{});assert.equal(calls,4);assert.equal(result.reason,'empty-lines');
});
test('404 does not trigger an immediate retry and retains the HTTP cause',async()=>{
 let calls=0;const result=await requestNativeLyrics({request:async()=>{calls++;return {lines:[],reason:'http-not-found',httpStatus:404};}},
 {trackId:'0SalvDj3mS5mOqsQsPFpnV'},()=>{},async()=>{});assert.equal(calls,1);assert.equal(result.httpStatus,404);
});
