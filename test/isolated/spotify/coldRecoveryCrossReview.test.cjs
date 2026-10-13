'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const {fixture,receipt}=require('./coldRecoveryFixture.cjs');
const v2={...receipt,version:2,baselineEmpty:true,targetActive:false,volumeOnly:true,volumeRequestPending:false,playbackRequestPending:false};
async function using(options,run){const f=await fixture(options);try{await run(f);}finally{await f.close();}}
for(const action of ['dispose','clear','supersede'])test(`${action} revokes pending empty recovery and late read cannot clear`,{timeout:2000},async()=>using({seed:v2,initialPaused:false},async f=>{
 let entered,release;const started=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;});
 f.override(async op=>{if(op==='player'){entered();await hold;}});
 const check=f.check(),rejected=assert.rejects(check);
 await started;
 let newer;
 if(action==='supersede'){newer=assert.rejects(f.prepare());}
 else await f.control[action]();
 await rejected;
 release();await new Promise(r=>setImmediate(r));await newer;
 assert.deepEqual(await f.retained(),v2);assert.ok(f.events.every(e=>e.startsWith('GET:')));
}));
for(const transition of ['grant','replace','rewrite'])test(`final receipt-read close ${transition} blocks compare-delete`,{timeout:2000},async()=>using({seed:v2,initialPaused:false},async f=>{
 const open=fs.open;let reads=0;
 const replacement={...v2,originalVolume:10};
 fs.open=async function(filename,flags,...rest){
  const handle=await open.call(this,filename,flags,...rest);
  if(filename===f.filename&&flags==='r'&&++reads===2){
   const close=handle.close.bind(handle);
   handle.close=async()=>{
    await close();
    if(transition==='grant')f.changeGrant();
    if(transition==='replace'){await fs.writeFile(f.filename+'.replacement',JSON.stringify(v2));await fs.rename(f.filename+'.replacement',f.filename);}
    if(transition==='rewrite')await fs.writeFile(f.filename,JSON.stringify(replacement));
   };
  }
  return handle;
 };
 try{await assert.rejects(f.check());assert.equal(reads,2);assert.deepEqual(await f.retained(),transition==='rewrite'?replacement:v2);}
 finally{fs.open=open;}
 assert.ok(f.events.every(e=>e.startsWith('GET:')));
}));
for(const outcome of ['success','invalid','cancel'])test(`external abort listener is removed after ${outcome}`,{timeout:2000},async()=>using({seed:v2,initialPaused:false},async f=>{
 const owner=new AbortController(),signal=owner.signal;let balance=0;
 const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
 signal.addEventListener=(type,...args)=>{if(type==='abort')balance++;return add(type,...args);};
 signal.removeEventListener=(type,...args)=>{if(type==='abort')balance--;return remove(type,...args);};
 if(outcome==='invalid')f.device.volume_percent=10;
 if(outcome==='cancel')f.override(async op=>{if(op==='player')owner.abort();});
 if(outcome==='success')assert.equal((await f.check(signal)).required,false);
 else await assert.rejects(f.check(signal));
 assert.equal(balance,0);
}));
test('v2 acknowledged but unconfirmed mute persists original exact value and read-only recovery has no audible write',{timeout:2000},async()=>using({seed:false,initialPaused:false},async f=>{
 f.override((op,init)=>init.method==='PUT'&&op==='volume'?new Response(null,{status:204}):undefined);
 await assert.rejects(f.prepare());
 const saved=await f.retained();assert.equal(saved.version,2);assert.equal(saved.volumeOnly,true);assert.equal(saved.volumeRequestPending,false);assert.equal(saved.originalVolume,9);
 const count=f.events.length;assert.equal((await f.check()).required,false);
 assert.deepEqual(f.events.slice(count),['GET:player','GET:devices','GET:player','GET:devices']);assert.equal(await f.retained(),null);assert.equal(f.device.volume_percent,9);
}));
