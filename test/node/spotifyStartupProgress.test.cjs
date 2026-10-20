'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createDesktopLifecycle}=require('../../electron/spotify/desktopLifecycle.cjs');
const {expected}=require('../../electron/spotify/wrapper/handshake.cjs');
const {EventEmitter}=require('node:events');
// Synthetic lifecycle only; existing Spotify processes and assets are never touched.
async function fixture(t,request){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-startup-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(path.join(directory,'xpui'));await fs.writeFile(path.join(directory,'xpui/index.html'),'fixture');
 let running=true,connected=true;
 const processInfo={pid:90000001,started:new Date().toISOString(),exe:'fixture.exe'};
 return createDesktopLifecycle({directory,apps:directory,ready:Promise.resolve(),log:()=>{},bridge:{connected:()=>connected,request},
 stop:async()=>{running=false;connected=false;},
 start:()=>{running=true;connected=true;const child=new EventEmitter();child.pid=processInfo.pid;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;},
 discovery:async()=>({candidates:[{id:'desktop',exe:'fixture.exe'}],running:running?[processInfo]:[]})});
}
test('initial busy snapshot joins existing wait, and simultaneous resume receives handshake completion',async t=>{
 let release;const wait=new Promise(r=>release=r);let snapshots=0;
 const lifecycle=await fixture(t,async op=>{if(op==='hello')return expected;
 if(++snapshots===1)throw Object.assign(Error('initializing'),{code:'CONTROL_REJECTED'});
 await wait;return {local:true,wrapperReady:true,account:'fixture',deviceId:'local'};});
 const first=[],second=[];const a=lifecycle.ensure(p=>first.push(p.stage));
 await new Promise(r=>setTimeout(r,20));const b=lifecycle.ensure(p=>second.push(p.stage));release();await Promise.all([a,b]);
 assert.equal(snapshots,2);for(const phases of [first,second]){assert.ok(phases.includes('spotifyHandshake'));assert.equal(phases.at(-1),'spotifyReady');}
});
test('unconfirmed handshake never reports success',async t=>{
 const lifecycle=await fixture(t,async()=>{throw Object.assign(Error('waiting'),{code:'CONTROL_REJECTED'});});const phases=[];
 await assert.rejects(lifecycle.ensure(p=>phases.push(p.stage)),{code:'SPOTIFY_BRIDGE_NOT_READY'});assert.ok(!phases.includes('spotifyReady'));
});
