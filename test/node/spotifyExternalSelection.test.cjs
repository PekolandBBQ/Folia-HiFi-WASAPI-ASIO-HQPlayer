'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createExternalSelectionCoordinator}=require('../../electron/spotify/externalSelectionCoordinator.cjs');
const {isNaturalTrackEnd,isExternalSeek}=require('../../electron/spotify/naturalTrackEnd.cjs');
const a='a'.repeat(22),b='b'.repeat(22),c='c'.repeat(22);
const facts={previousTrackId:a,trackId:b,positionMs:400};
function fixture(stopOutput=async()=>({})){const events=[];let actual={uri:'spotify:track:'+b,positionMs:600};let handedBack=0;
 const service=createExternalSelectionCoordinator({send:e=>events.push(e),stopOutput,sample:async()=>actual,
  continueSpotify:async()=>handedBack++,name:id=>id,log:()=>{}});
 return {service,events,setActual:v=>actual=v,handedBack:()=>handedBack};}
test('confirmation appears before slow cleanup; cancellation drains old cleanup without affecting new playback',async()=>{
 let finish;const f=fixture(()=>new Promise(r=>finish=r));
 const pending=f.service.notify(facts);assert.equal(f.events[0].phase,'paused');await Promise.resolve();
 const barrier=f.service.cancel();finish({});await barrier;await pending;
 assert.equal((await f.service.decide(1,'follow')).stale,true);assert.equal(f.events.at(-1).phase,'dismiss');
});
test('cleanup failure leaves an actionable confirmation instead of losing the prompt',async()=>{
 const f=fixture(async()=>{throw Error('failure');});await f.service.notify(facts);
 assert.match(f.events.at(-1).error,/旧输出/);await assert.rejects(f.service.decide(1,'follow'),/failure/);
 await f.service.decide(1,'pause');assert.equal(f.events.at(-1).phase,'dismiss');
});
test('follow returns refreshed position, and a second desktop change requires new confirmation',async()=>{
 const f=fixture();await f.service.notify(facts);f.setActual({uri:'spotify:track:'+c,positionMs:900});
 assert.equal((await f.service.decide(1,'follow')).changed,true);assert.equal(f.events.at(-1).trackId,c);
 await f.service.decide(1,'follow');assert.equal(f.events.at(-1).phase,'follow');assert.equal(f.events.at(-1).positionMs,900);
});
test('natural completion advances once; a stale source never pauses new playback',async()=>{
 const f=fixture();await f.service.notify({...facts,naturalEnd:true});
 assert.deepEqual(f.events.map(e=>e.phase),['paused','advance']);
 await f.service.notify(facts,()=>false);assert.equal(f.events.length,2);
});
test('explicit Spotify continuation restores output before requesting playback',async()=>{
 const f=fixture();await f.service.notify(facts);await f.service.decide(1,'spotify');assert.equal(f.handedBack(),1);assert.equal(f.events.at(-1).phase,'dismiss');
});
test('same-song external seek aligns playback after cleanup without asking to change songs',async()=>{
 const f=fixture();await f.service.notify({...facts,trackId:a,externalSeek:true,positionMs:45000});
 assert.deepEqual(f.events.map(e=>e.phase),['paused','follow']);
 assert.equal(f.events[0].externalSeek,true);assert.equal(f.events[1].positionMs,45000);
});
test('external seek accepts forward/backward jumps but excludes drift, stale clocks and changed tracks',()=>{
 const old={trackId:a,positionMs:30000,observedAt:1000,isPlaying:true};
 const next={...old,observedAt:2000,positionMs:31000};
 assert.equal(isExternalSeek(old,next),false);
 assert.equal(isExternalSeek(old,{...next,positionMs:32000}),false);
 assert.equal(isExternalSeek(old,{...next,positionMs:90000}),true);
 assert.equal(isExternalSeek(old,{...next,positionMs:5000}),true);
 assert.equal(isExternalSeek(old,{...next,trackId:b,positionMs:5000}),false);
 assert.equal(isExternalSeek(undefined,next),false);
 assert.equal(isExternalSeek(old,{...next,observedAt:20000}),false);
});
test('consecutive desktop selections retain the original Folia track and serialize cleanup',async()=>{
 let finish,calls=0;const f=fixture(()=>{calls++;return calls===1?new Promise(r=>finish=r):Promise.resolve({});});
 const first=f.service.notify(facts);await Promise.resolve();
 const second=f.service.notify({...facts,previousTrackId:b,trackId:c});
 assert.equal(f.events.at(-1).previousTrackId,a);assert.equal(f.events.at(-1).trackId,c);
 assert.equal(calls,1);finish({});await first;await second;assert.equal(calls,2);
 assert.equal((await f.service.decide(1,'follow')).stale,true);
 f.setActual({uri:'spotify:track:'+c,positionMs:900});await f.service.decide(2,'follow');
 assert.equal(f.events.at(-1).phase,'follow');assert.equal(f.events.at(-1).previousTrackId,a);
});
test('a failed cleanup can recover on confirmation without losing the pending choice',async()=>{
 let calls=0;const f=fixture(async()=>{if(++calls===1)throw Error('temporary');return {};});
 await f.service.notify(facts);await f.service.decide(1,'follow');
 assert.equal(calls,2);assert.equal(f.events.at(-1).phase,'follow');
});
test('natural-end evidence covers next and same-track repeat but rejects mid-song changes and stale samples',()=>{
 const old={isPlaying:true,positionMs:99000,durationMs:100000,observedAt:1000};
 assert.equal(isNaturalTrackEnd(old,{positionMs:500,observedAt:3000}),true);
 assert.equal(isNaturalTrackEnd({...old,positionMs:40000},{positionMs:0,observedAt:3000}),false);
 assert.equal(isNaturalTrackEnd(old,{positionMs:0,observedAt:15000}),false);
 assert.equal(isNaturalTrackEnd({...old,isPlaying:false},{positionMs:0,observedAt:3000}),false);
});

test('external pause keeps Folia paused without following or advancing',async()=>{
 const f=fixture();await f.service.notify({...facts,trackId:a,externalPause:true});
 assert.deepEqual(f.events.map(e=>e.phase),['paused','dismiss']);
 assert.equal(f.events[0].externalPause,true);assert.equal(f.handedBack(),0);
});

test('external same-song resume follows its current position after output cleanup',async()=>{
 const f=fixture();await f.service.notify({...facts,trackId:a,externalResume:true,positionMs:35000});
 assert.deepEqual(f.events.map(e=>e.phase),['paused','follow']);
 assert.equal(f.events[0].externalResume,true);
 assert.equal(f.events[1].externalResume,true);assert.equal(f.events[1].positionMs,35000);
 assert.equal(f.handedBack(),0);
});
