'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {expected,inspectHandshake,inspectRuntime,requireHandshake}=require('../electron/spotify/wrapper/handshake.cjs');
// Verify live replies rather than installed files or a connected socket alone.
const bridge=value=>({connected:()=>true,request:async op=>{assert.equal(op,'hello');return value;}});
test('runtime handshake requires protocol and declared capabilities, accepts compatible newer versions',async()=>{
 assert.equal((await inspectHandshake(bridge(expected))).state,'ready');
 assert.equal((await inspectHandshake(bridge({...expected,version:'1.4.0'}))).state,'ready');
 assert.equal((await inspectHandshake(bridge({...expected,version:'1.2.1'}))).state,'outdated');
 assert.equal((await inspectHandshake(bridge({...expected,version:'1.2.0'}))).state,'outdated');
 for(const value of [{},{...expected,protocol:2},{...expected,capabilities:['snapshot']}] )assert.equal((await inspectHandshake(bridge(value))).state,'outdated');
 await assert.rejects(requireHandshake(bridge({})),{code:'BRIDGE_UPDATE_REQUIRED'});
});
test('legacy and temporarily unreachable bridges remain distinct',async()=>{
 for(const [code,state] of [['SOURCE_OPERATION_UNSUPPORTED','outdated'],['CONTROL_TIMEOUT','unconfirmed']])assert.equal((await inspectHandshake({request:async()=>{throw Object.assign(Error(),{code});}})).state,state);
});
test('disconnected startup evidence separates missing, wrong and unknown resource directories',async()=>{
 const b={connected:()=>false};const inspect=p=>inspectRuntime(b,[p],'C:/Folia/AppX');
 assert.equal((await inspect({mainProcess:true,commandLineKnown:true})).state,'unmanaged');
 assert.equal((await inspect({mainProcess:true,commandLineKnown:true,appDirectory:'C:/Other/AppX'})).state,'wrong-assets');
 assert.equal((await inspect({mainProcess:true,commandLineKnown:true,appDirectory:'C:/Folia/AppX'})).state,'waiting');
 assert.equal((await inspect({})).state,'waiting');assert.equal((await inspectRuntime(b,[],'C:/Folia/AppX')).state,'stopped');
});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createDesktopLifecycle}=require('../electron/spotify/desktopLifecycle.cjs');
for(const initial of ['outdated','old-version','unmanaged','ready'])test('automatic connection handles '+initial+' without requiring manual Spotify restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'folia-auto-connect-'));fs.mkdirSync(path.join(dir,'xpui'));fs.writeFileSync(path.join(dir,'xpui/index.html'),'');
 let state=initial,running=true,starts=0,stops=0;const started=new Date().toISOString();
 const snapshot={local:true,wrapperReady:true,account:'test',deviceId:'local'};
 const b={connected:()=>running&&state!=='unmanaged',request:async op=>{if(op==='hello'){if(state==='outdated')throw Object.assign(Error(),{code:'SOURCE_OPERATION_UNSUPPORTED'});return state==='old-version'?{...expected,version:'1.2.0'}:expected;}return snapshot;}};
 const lifecycle=createDesktopLifecycle({directory:dir,apps:dir,ready:Promise.resolve(),bridge:b,log:()=>{},dialog:{showMessageBox:()=>assert.fail('no prompt')},parent:()=>null,
 discovery:async()=>({candidates:[{id:'desktop',exe:'test.exe',layout:'desktop'}],errors:[],running:running?[{pid:123,exe:'test.exe',started,mainProcess:true,commandLineKnown:true,appDirectory:state==='unmanaged'?null:dir}]:[]}),
 stop:async()=>{stops++;running=false;},start:()=>{starts++;state='ready';running=true;const child=Object.assign(new EventEmitter(),{pid:123,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}});
 try{await Promise.all([lifecycle.ensure(),lifecycle.ensure()]);assert.equal((await lifecycle.inspect()).bridgeRuntime.state,'ready');assert.equal(starts,initial==='ready'?0:1);assert.equal(stops,initial==='ready'?0:1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('stale in-memory connection is reloaded once and shared callers resume without repeated waiting',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'folia-stale-bridge-'));fs.mkdirSync(path.join(dir,'xpui'));fs.writeFileSync(path.join(dir,'xpui/index.html'),'');
 let running=true,connected=false,rejection={reason:'connection-key-mismatch'},starts=0,stops=0;
 const b={connected:()=>connected,connectionFailure:()=>rejection,clearConnectionFailure:()=>{rejection=undefined;},request:async op=>op==='hello'?expected:{local:true,wrapperReady:true,account:'test',deviceId:'local'}};
 const lifecycle=createDesktopLifecycle({directory:dir,apps:dir,ready:Promise.resolve(),bridge:b,log:()=>{},dialog:{showMessageBox:()=>assert.fail('no prompt')},parent:()=>null,
 discovery:async()=>({candidates:[{id:'desktop',exe:'test.exe',layout:'desktop'}],errors:[],running:running?[{pid:123,exe:'test.exe',started:'2026-10-18',mainProcess:true,commandLineKnown:true,appDirectory:dir}]:[]}),
 stop:async()=>{stops++;running=false;connected=false;},start:()=>{starts++;running=true;connected=true;const child=Object.assign(new EventEmitter(),{pid:123,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}});
 try{await Promise.all([lifecycle.ensure(),lifecycle.ensure()]);assert.equal(starts,1);assert.equal(stops,1);await lifecycle.ensure();assert.equal(starts,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a persistently rejected replacement does not cause a restart loop on further retries',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'folia-rejected-bridge-'));fs.mkdirSync(path.join(dir,'xpui'));fs.writeFileSync(path.join(dir,'xpui/index.html'),'');let running=true,starts=0,reason={reason:'connection-key-mismatch'};
 const b={connected:()=>false,connectionFailure:()=>reason,clearConnectionFailure:()=>{reason=undefined;}};
 const lifecycle=createDesktopLifecycle({directory:dir,apps:dir,ready:Promise.resolve(),bridge:b,log:()=>{},dialog:{},parent:()=>null,discovery:async()=>({candidates:[{id:'desktop',exe:'test.exe',layout:'desktop'}],errors:[],running:running?[{pid:123,exe:'test.exe',started:'2026-10-18',mainProcess:true,commandLineKnown:true,appDirectory:dir}]:[]}),stop:async()=>{running=false;},start:()=>{starts++;running=true;reason={reason:'connection-key-mismatch'};const child=Object.assign(new EventEmitter(),{pid:123,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;}});
 try{for(let attempt=0;attempt<4;attempt++)await assert.rejects(lifecycle.ensure(),{code:'SPOTIFY_BRIDGE_NOT_READY'});assert.equal(starts,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
