'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{EventEmitter,once}=require('node:events');
const {launchUpdateWaiter}=require('../../electron/forkUpdateLauncher.cjs');
// Exercise Windows PowerShell itself: a mocked spawn event missed its silent detached exit.
test('Windows helper really starts and waits without running an installer',{skip:process.platform!=='win32'},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-waiter-'));let child;
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const result=await launchUpdateWaiter({directory,installer:path.join(directory,'not-an-installer.exe'),application:process.execPath,parentId:process.pid,
  launch:(cmd,args,options)=>{child=spawn(cmd,args,options);return child;}});
 assert.match(await fs.readFile(result.log,'utf8'),/helper-start/);
 assert.doesNotMatch(await fs.readFile(result.log,'utf8'),/starting-installer/);
 const exited=once(child,'exit');child.kill();await exited;
});
test('early helper exit and missing readiness reject before app exit is permitted',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-waiter-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const early of [true,false]){
  let killed=false;
  await assert.rejects(launchUpdateWaiter({directory,installer:'fixture.exe',application:process.execPath,parentId:process.pid,timeoutMs:60,
   launch:()=>{const child=new EventEmitter();child.kill=()=>{killed=true;};child.unref=()=>assert.fail('must not detach an unready helper');if(early)setImmediate(()=>child.emit('exit',0));return child;}}),/更新助手/);
  assert.equal(killed,true);
 }
});
