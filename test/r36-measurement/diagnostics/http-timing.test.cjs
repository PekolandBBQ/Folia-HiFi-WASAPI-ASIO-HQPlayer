'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
// Isolated candidate code uses production module identities; no production file is overwritten.
const app = path.resolve(__dirname,'../../..');
let monotonic = 0;
function load(file,subdirectory='candidate') {
  const filename = path.join(app,file), loaded = new Module(filename,module);
  loaded.filename=filename;loaded.paths=module.paths;
  const requireReal=loaded.require.bind(loaded);
  loaded.require=id=>id==='node:perf_hooks'?{performance:{now:()=>monotonic}}:requireReal(id);
  loaded._compile(fs.readFileSync(path.join(__dirname,subdirectory,file),'utf8'),filename);
  require.cache[filename]=loaded;return loaded.exports;
}
const {projectEvent}=load('electron/debug/privatePreviewDiagnosticSchema.cjs');
const {installPreviewDiagnosticSink}=require(path.join(app,'electron/debug/privatePreviewDiagnosticBus.cjs'));
const {reportSpotifyHttp}=load('electron/spotify/requestDiagnostics.cjs');
load('electron/spotify/desktopPlaybackFacts.cjs','dependencies');
load('electron/spotify/sessionVault.cjs','dependencies');
const {createDesktopPlaybackApi}=load('electron/spotify/desktopPlaybackApi.cjs');
load('electron/spotify/cableAudioPreparation.cjs');
load('electron/spotify/desktopPlaybackControl.cjs','dependencies');
const stamp={epoch:0,revision:0};
const vault={token:async()=>{monotonic+=1000;return'PRIVATE_TOKEN';},stamp:()=>stamp,grantedScopes:async()=>({...stamp,scopes:['user-read-playback-state','user-modify-playback-state']})};
const cooldown={load:async()=>0,defer:async()=>0};
const record=()=>({stamp,controller:new AbortController(),deviceId:'PRIVATE_DEVICE',trackId:'A'.repeat(22)});
function observe(t,enabled=true){const rows=[];const detach=installPreviewDiagnosticSink({enabled:()=>enabled,record:(type,fields)=>{rows.push({type,fields});return true;}});t.after(detach);return rows;}
const http=rows=>rows.filter(x=>x.type==='spotify.http');

for(const value of [0,1,59999,60000])test(`HTTP elapsed accepts bounded integer ${value}`,()=>{
  assert.equal(projectEvent('spotify.http',{endpoint:'playback-state',method:'GET',httpStatus:200,elapsedMs:value}).fields.elapsedMs,value);
});
for(const value of [-1,60001,1.5,NaN,Infinity,'37',null,{secret:'PRIVATE_BODY'}])test(`HTTP elapsed rejects ${String(value)}`,()=>{
  const valueOut=projectEvent('spotify.http',{endpoint:'playback-state',method:'GET',httpStatus:200,elapsedMs:value});
  assert.equal(Object.hasOwn(valueOut.fields,'elapsedMs'),false);
});
test('HTTP timing projection never invokes getters or includes URL/token/body',t=>{
  const rows=observe(t);let reads=0;const input={endpoint:'playback-state',method:'GET',httpStatus:200,url:'PRIVATE_URL',body:'PRIVATE_BODY',token:'PRIVATE_TOKEN'};
  Object.defineProperty(input,'elapsedMs',{get(){reads++;throw Error('private');}});
  const value=projectEvent('spotify.http',input);assert.equal(reads,0);assert.deepEqual(value.fields,{endpoint:'playback-state',method:'GET',httpStatus:200});
  reportSpotifyHttp('playback-state','GET',204,undefined,undefined,{url:'PRIVATE_URL',token:'PRIVATE_TOKEN'},57);
  assert.equal(http(rows)[0].fields.elapsedMs,57);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|https?:|Authorization/);
});
test('GET measures dispatch to headers, excluding auth and slow JSON body',async t=>{
  const rows=observe(t);monotonic=0;let requests=0,releaseBody;
  const bodyGate=new Promise(resolve=>releaseBody=resolve);
  const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{requests++;monotonic+=73;return new Response(new ReadableStream({async start(controller){await bodyGate;controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();}}),{status:200,headers:{'content-type':'application/json'}});}});
  const pending=api.request('state',record(),()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(http(rows)[0].fields.elapsedMs,73);monotonic+=500;releaseBody();assert.deepEqual(await pending,{ok:true});
  assert.equal(http(rows)[0].fields.elapsedMs,73);assert.equal(requests,1);
});
test('PUT204 has header timing and unchanged acknowledgment/write accounting',async t=>{
  const rows=observe(t);monotonic=0;const value=record();
  const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{monotonic+=91;return new Response(null,{status:204});}});
  assert.equal(await api.request('pause',value,()=>{}),null);assert.equal(http(rows)[0].fields.elapsedMs,91);assert.equal(api.hasUnsettledWrites(),false);
});
test('PUT200 drain excludes body wait, preserves ambiguous response classification',async t=>{
  const rows=observe(t);monotonic=0;let releaseBody;const gate=new Promise(resolve=>releaseBody=resolve);
  const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{monotonic+=61;return new Response(new ReadableStream({async start(controller){await gate;controller.enqueue(new TextEncoder().encode('opaque accepted'));controller.close();}}),{status:200});}});
  const pending=api.request('pause',record(),()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(http(rows)[0].fields.elapsedMs,61);
  monotonic+=900;releaseBody();assert.deepEqual(await pending,{acknowledgment:'UNCONFIRMED'});assert.equal(http(rows)[0].fields.elapsedMs,61);
});
for(const [status,code] of [[401,'AUTH_REQUIRED'],[403,'API_FORBIDDEN'],[404,'PLAYBACK_UNAVAILABLE'],[429,'RATE_LIMITED'],[500,'API_UNAVAILABLE']])test(`HTTP${status} records headers but retains original failure`,async t=>{
  const rows=observe(t);monotonic=0;const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{monotonic+=83;return new Response('PRIVATE_BODY',{status});}});
  await assert.rejects(api.request('pause',record(),()=>{}),{code});assert.equal(http(rows)[0].fields.elapsedMs,83);assert.equal(http(rows)[0].fields.httpStatus,status);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_BODY|PRIVATE_TOKEN|PRIVATE_DEVICE/);
});
test('network failure before headers has no fabricated HTTP timing',async t=>{
  const rows=observe(t);const failure=Error('PRIVATE_NETWORK_FAILURE');const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{throw failure;}});
  await assert.rejects(api.request('state',record(),()=>{}),error=>error===failure);assert.equal(http(rows).length,0);
});
test('cancel before headers preserves cancellation and omits timing even if producer is late',async t=>{
  const rows=observe(t);let settle;const gate=new Promise(resolve=>settle=resolve),signal=new AbortController();
  const api=createDesktopPlaybackApi({vault,cooldown,fetcher:()=>gate});const pending=api.request('state',record(),()=>{},{signal:signal.signal});
  await new Promise(resolve=>setImmediate(resolve));signal.abort();await assert.rejects(pending,{code:'CANCELLED'});settle(new Response(null,{status:204}));await new Promise(resolve=>setImmediate(resolve));assert.equal(http(rows).length,0);
});
test('disabled diagnostics remain inert and requests retain their behavior',async t=>{
  const rows=observe(t,false);let calls=0;const api=createDesktopPlaybackApi({vault,cooldown,fetcher:async()=>{calls++;return new Response(null,{status:204});}});
  assert.equal(await api.request('state',record(),()=>{}),null);assert.equal(calls,1);assert.equal(rows.length,0);
});
test('actual cable metadata reports header duration, while warm cache adds no HTTP event',async t=>{
  const rows=observe(t);process.env.FOLIA_SOURCE_TEST_APP=app;
  const {fixture}=require('../source-fixture.cjs');const f=await fixture({getDelayMs:1,putDelayMs:1,realSetup:true});t.after(()=>f.close());
  f.hooks.http=({operation})=>{if(operation==='metadata')monotonic+=47;};
  await f.prepare();const first=http(rows).filter(x=>x.fields.endpoint==='playback-track');assert.equal(first.length,1);assert.equal(first[0].fields.elapsedMs,47);
  await f.prepare();assert.equal(http(rows).filter(x=>x.fields.endpoint==='playback-track').length,1);
});
