const {test}=require('node:test'),assert=require('node:assert/strict');
const {settleQuitCleanup}=require('../electron/quitCleanup.cjs');
// Exit must settle for success, errors, hung cleanup, and even a failing logger.
test('quit cleanup handles failure and timeout without retaining the application',async()=>{
 const errors=[];await settleQuitCleanup(()=>{throw Error('restore failed');},e=>errors.push(e.message));
 assert.deepEqual(errors,['restore failed']);
 await settleQuitCleanup(()=>new Promise(()=>{}),e=>errors.push(e.code),10);
 assert.equal(errors[1],'QUIT_CLEANUP_TIMEOUT');
 await settleQuitCleanup(()=>Promise.reject(Error('failure')),()=>{throw Error('logger');});
 await settleQuitCleanup(()=>Promise.resolve(),()=>assert.fail());
});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createDesktopLifecycle}=require('../electron/spotify/desktopLifecycle.cjs');
test('Folia-owned Spotify is retained on quit without a confirmation dialog',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'folia-quit-owned-'));fs.mkdirSync(path.join(directory,'xpui'));fs.writeFileSync(path.join(directory,'xpui/index.html'),'');
 let connected=false;let started=0;const logs=[];
 const lifecycle=createDesktopLifecycle({directory,apps:directory,ready:Promise.resolve(),bridge:{connected:()=>connected,request:async op=>op==='hello'?require('../electron/spotify/wrapper/handshake.cjs').expected:({local:true,wrapperReady:true,account:'test',deviceId:'local'})},
  log:(event,data)=>logs.push({event,...data}),dialog:{showMessageBox:()=>assert.fail('Quit must not ask')},parent:()=>null,
  discovery:async()=>({candidates:[{id:'desktop',exe:'test-spotify.exe',layout:'desktop'}],running:connected?[{pid:1,exe:'test-spotify.exe',started:new Date(started).toISOString()}]:[],errors:[]}),
  start:()=>{const child=Object.assign(new EventEmitter(),{pid:1,unref(){}});started=Date.now();queueMicrotask(()=>{connected=true;child.emit('spawn');});return child;}});
 try{await lifecycle.ensure();assert.equal((await lifecycle.inspect()).owned,true);await lifecycle.offerExit('quit');assert.equal((await lifecycle.inspect()).owned,false);assert.ok(logs.some(x=>x.event==='spotify-background-retained'&&x.reason==='quit'));}
 finally{fs.rmSync(directory,{recursive:true,force:true});}
});
