'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{EventEmitter,once}=require('node:events');
const {launchUpdateWaiter}=require('../../electron/forkUpdateLauncher.cjs');
// A real parent exit must not terminate the updater with the application.
test('Windows helper survives parent exit and only then attempts installation',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia 更新助手 '));
 const launcher=require.resolve('../../electron/forkUpdateLauncher.cjs');
 const options={directory,installer:path.join(directory,'missing setup.exe'),application:process.execPath};
 const code=`require(${JSON.stringify(launcher)}).launchUpdateWaiter({...${JSON.stringify(options)},parentId:process.pid,launch:require('node:child_process').spawn}).then(r=>{process.stdout.write(JSON.stringify(r)+'\\n');setTimeout(()=>process.exit(0),500)}).catch(e=>{console.error(e);process.exit(1)})`;
 const parent=spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';parent.stdout.on('data',b=>stdout+=b);parent.stderr.on('data',b=>stderr+=b);
 assert.equal((await once(parent,'exit'))[0],0,stderr);
 const {log}=JSON.parse(stdout.trim());let content='';
 for(let n=0;n<100;n++) {try{content=await fs.readFile(log,'utf8');}catch(e){if(e.code!=='EBUSY')throw e;}if(content.includes('failed:'))break;await new Promise(r=>setTimeout(r,50));}
 assert.match(content,/ready-waiting-for-normal-exit/);
 assert.match(content,/parent-exited-starting-installer/);
 assert.match(content,/failed:/); // Missing fixture installer proves the helper reached launch, without installing anything.
 assert.ok(content.indexOf('ready-waiting')<content.indexOf('parent-exited'));
 await fs.rm(directory,{recursive:true,force:true});
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

