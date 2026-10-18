'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createComponentInstall}=require('../../electron/spotify/componentInstall.cjs');
const {createDesktopLifecycle}=require('../../electron/spotify/desktopLifecycle.cjs');
// Configuration sequencing and failure boundaries; no user processes or profiles are modified.
async function temporary(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-one-click-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
for(const connected of [true,false])test(`configuration completes only after live connection: ${connected}`,async t=>{
 const directory=await temporary(t),calls=[];
 const current={installations:[{}],selected:'desktop',running:true,engine:true,cli:true,driver:true,driverEndpointsReady:true,wrapper:false,extension:false,connected:false};
 const install=createComponentInstall({directory,inspect:async()=>current,
  prepareConfiguration:async()=>calls.push('restore-and-stop'),
  configureSpicetify:async()=>{calls.push('configure');current.wrapper=current.extension=true;},
  connect:async()=>{calls.push('connect');current.connected=connected;}});
 install.start('configure');await install.settled();
 assert.deepEqual(calls,['restore-and-stop','configure','connect']);
 assert.equal((await install.status()).phase,connected?'complete':'failed');
 if(!connected){assert.equal((await install.status()).code,'SPOTIFY_BRIDGE_NOT_READY');assert.match((await install.status()).detail,/桥接/);}
});
test('restore failure prevents process stop, asset mutation and launch',async t=>{
 const directory=await temporary(t),calls=[];
 const install=createComponentInstall({directory,inspect:async()=>({installations:[{}],selected:'desktop',engine:true,cli:true,driver:true}),
 prepareConfiguration:async()=>{throw Object.assign(Error('restore'),{code:'EXTERNAL_POLICY_CONFLICT'});},
 configureSpicetify:async()=>calls.push('configure'),connect:async()=>calls.push('connect')});
 install.start('configure');await install.settled();assert.deepEqual(calls,[]);
 assert.equal((await install.status()).code,'EXTERNAL_POLICY_CONFLICT');assert.match((await install.status()).detail,/输出路由/);
});
test('selected desktop process is stopped and its disconnected state confirmed',async t=>{
 const directory=await temporary(t),p={pid:12,started:'2026-10-15',exe:'C:\\Spotify.exe'};let running=[p],connected=true;
 const desktop=createDesktopLifecycle({directory,bridge:{connected:()=>connected},log:()=>{},
 discovery:async()=>({candidates:[{id:'desktop',exe:p.exe}],running}),stop:async value=>{assert.deepEqual(value,p);running=[];connected=false;}});
 await desktop.stopForConfiguration();assert.deepEqual(running,[]);
});
test('a different installation is not stopped',async t=>{
 const directory=await temporary(t);let stopped=false;
 const desktop=createDesktopLifecycle({directory,bridge:{connected:()=>false},log:()=>{},
 discovery:async()=>({candidates:[{id:'desktop',exe:'C:\\Spotify.exe'}],running:[{exe:'D:\\Spotify.exe'}]}),stop:async()=>{stopped=true;}});
 await assert.rejects(desktop.stopForConfiguration(),{code:'SPOTIFY_OTHER_INSTALL_RUNNING'});assert.equal(stopped,false);
});
