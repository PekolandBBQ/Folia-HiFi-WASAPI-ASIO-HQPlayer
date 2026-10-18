'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {repository,releasesUrl,selectUpdate,createForkUpdates}=require('../../electron/forkUpdates.cjs');
const current={forkTag:'folia-hifi-v0.7.19-r4',build:'1792300000000'};
function release(tag=current.forkTag){return {tag_name:tag,draft:false,prerelease:false,body:'修复说明',assets:['installer.exe','portable.zip','folia-hifi-update.json'].map(name=>({name,size:4,browser_download_url:`${releasesUrl}/download/${tag}/${name}`}))};}
const manifest=(build='1792300000001',tag=current.forkTag)=>({schema:1,tag,build,installer:'installer.exe',portable:'portable.zip'});
test('only higher versions or higher same-tag builds update',()=>{
 assert.equal(selectUpdate(release(),manifest(),current,true).status,'available');
 for(const build of ['1792300000000','1792299999999'])assert.equal(selectUpdate(release(),manifest(build),current,true).status,'latest');
 for(const tag of ['folia-hifi-v0.7.19-r5','folia-hifi-v0.7.20-r1'])assert.equal(selectUpdate(release(tag),manifest('1792300000000',tag),current,true).status,'available');
 const older='folia-hifi-v0.7.19-r3';assert.equal(selectUpdate(release(older),manifest('1792399999999',older),current,true).status,'latest');
});
test('rejects preview, foreign assets and mismatched manifests; old same-version releases do not invent a build',()=>{
 for(const change of [{draft:true},{prerelease:true},{tag_name:'v0.7.20'}])assert.throws(()=>selectUpdate({...release(),...change},manifest(),current,true));
 assert.throws(()=>selectUpdate(release(),manifest('1792300000001','other'),current,true));
 const r=release();r.assets[0].browser_download_url='https://github.com/upstream/app/installer.exe';assert.throws(()=>selectUpdate(r,manifest(),current,true));
 assert.equal(selectUpdate(release(),null,current,true).status,'latest');
 assert.ok(selectUpdate(release(),manifest(),current,false).downloadUrl.endsWith('portable.zip'));
});
async function fixture(t,{installed=true,fail=false,bytes='data',confirm=true}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-update-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const states=[],calls=[],opened=[],installs=[];
 const service=createForkUpdates({current,installed,directory,publish:s=>states.push(s),openExternal:async u=>opened.push(u),install:async f=>{if(confirm)installs.push(f);return confirm;},fetcher:async url=>{
 calls.push(url);if(fail)throw Error('网络暂不可用');if(url.includes('/releases/latest'))return Response.json(release());if(url.includes('folia-hifi-update.json'))return Response.json(manifest());return new Response(bytes);
 }});return {service,directory,states,calls,opened,installs};
}
test('check is shared and only fork is queried; download is explicit and install requires confirmation',async t=>{
 const f=await fixture(t);await Promise.all([f.service.check(),f.service.check()]);assert.equal(f.calls.length,2);assert.ok(f.calls[0].includes(repository));assert.equal(f.installs.length,0);
 await f.service.download();assert.equal(f.states.at(-1).status,'downloaded');assert.equal(f.installs.length,0);assert.equal(await f.service.confirmInstall(),true);assert.equal(await fs.readFile(f.installs[0],'utf8'),'data');
});
test('portable download opens matching ZIP without installing',async t=>{const f=await fixture(t,{installed:false});await f.service.check();await f.service.download();assert.ok(f.opened[0].endsWith('portable.zip'));assert.equal(await f.service.confirmInstall(),false);});
test('incomplete download cannot install',async t=>{const f=await fixture(t,{bytes:'bad'});await f.service.check();await f.service.download();assert.equal(f.states.at(-1).status,'error');assert.equal(await f.service.confirmInstall(),false);});
test('background network failure is quiet; manual failure explains reason',async t=>{const f=await fixture(t,{fail:true});await f.service.check();assert.equal(f.states.at(-1).error,undefined);await f.service.check({manual:true});assert.equal(f.states.at(-1).error,'GitHub：网络暂不可用；Gitee：网络暂不可用');});
test('cancelled confirmation preserves downloaded package and does not install',async t=>{const f=await fixture(t,{confirm:false});await f.service.check();await f.service.download();assert.equal(await f.service.confirmInstall(),false);assert.equal(f.installs.length,0);assert.equal(f.states.at(-1).status,'downloaded');});
test('copied uninstaller is not proof of an installed app',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,'Uninstall Folia-HiFi-WASAPI-ASIO-HQPlayer.exe'),'fixture');
 const {isInstalled}=require('../../electron/forkUpdateIntegration.cjs');assert.equal(isInstalled(f.directory,()=>''),false);assert.equal(isInstalled(f.directory,()=>path.join(f.directory,'Uninstall Folia-HiFi-WASAPI-ASIO-HQPlayer.exe')),true);
});
test('installed confirmation waits for helper readiness before normal quit',async t=>{
 const f=await fixture(t);const {create}=require('../../electron/forkUpdateIntegration.cjs'),{EventEmitter}=require('node:events');let answer=0,quits=0;const launches=[];
 const service=create({current,installed:true,app:{getPath:()=>f.directory,quit:()=>quits++},publish:()=>{},shell:{},dialog:{showMessageBox:async()=>({response:answer})},session:{fromPartition:name=>{assert.equal(name,'folia-fork-update');return {fetch:async url=>url.includes('/releases/latest')?Response.json(release()):url.includes('folia-hifi-update.json')?Response.json(manifest()):new Response('data')};}},launch:(cmd,args,options)=>{launches.push({cmd,args,options});const child=new EventEmitter();child.unref=()=>{};setImmediate(()=>{assert.equal(quits,0);require('node:fs').writeFileSync(args[args.indexOf('-ReadyFile')+1],'ready');});return child;}});
 await service.check();await service.download();assert.equal(quits,0);assert.equal(await service.confirmInstall(),false);assert.equal(launches.length,0);
 answer=1;assert.equal(await service.confirmInstall(),true);assert.equal(quits,1);assert.equal(launches.length,1);assert.equal(launches[0].options.windowsHide,true);
 assert.equal(launches[0].options.detached,false);const script=await fs.readFile(launches[0].args[launches[0].args.indexOf('-File')+1],'utf8');assert.ok(script.indexOf('WaitForExit(120000)')<script.indexOf('$setup = Start-Process'));assert.ok(!script.includes('Stop-Process'));
});
const {sources}=require('../../electron/forkUpdateSources.cjs');
async function mirrorFixture(t,{preference='auto',githubFails=true,mirrorBuild='1792300000001',empty=false,downloadFails=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-mirror-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const calls=[],states=[];
 const g=release();g.id=42;g.assets=g.assets.map((a,i)=>({...a,id:i+1,browser_download_url:`https://gitee.com/attachments/download/${i+1}`}));
 const service=createForkUpdates({current,installed:true,getSource:()=>preference,directory,publish:s=>states.push(s),install:async()=>true,fetcher:async url=>{
 calls.push(url);
 if(url.startsWith('https://api.github.com/')){if(githubFails)throw Error('fetch failed');return Response.json(release());}
 if(url.includes('/releases/latest'))return empty?new Response('',{status:404}):Response.json(g);
 if(url.includes('/attach_files'))return Response.json(g.assets);
 if(url.includes('folia-hifi-update.json'))return Response.json(manifest());
 if(url==='https://gitee.com/attachments/download/3'||url.startsWith('https://gitee.com/attachments/download/3?'))return Response.json(manifest(mirrorBuild));
 if(downloadFails&&url.startsWith('https://github.com/'))throw Error('fetch failed');
 return new Response('data');
 }});return {service,calls,states};
}
test('auto falls back to the specified Gitee repository and normalizes attachments',async t=>{
 const f=await mirrorFixture(t);await f.service.check({manual:true});assert.equal(f.states.at(-1).updateSource,'gitee');assert.equal(f.states.at(-1).status,'available');assert.ok(f.calls.some(u=>u.includes(sources.gitee.repository+'/releases/42/attach_files')));await f.service.download();assert.equal(f.states.at(-1).status,'downloaded');
});
test('manual Gitee selection does not query GitHub',async t=>{const f=await mirrorFixture(t,{preference:'gitee'});await f.service.check();assert.ok(f.calls.every(u=>!u.includes('github.com')));});
test('empty Gitee does not report latest and names both failing sources',async t=>{const f=await mirrorFixture(t,{empty:true});await f.service.check({manual:true});assert.equal(f.states.at(-1).status,'error');assert.ok(f.states.at(-1).error.includes('Gitee'));assert.ok(!f.states.some(s=>s.status==='latest'));});
test('failed GitHub download can switch only to the identical Gitee build',async t=>{
 for(const build of ['1792300000001','1792300000000']){const f=await mirrorFixture(t,{githubFails:false,downloadFails:true,mirrorBuild:build});await f.service.check();await f.service.download();assert.equal(f.states.at(-1).status,build==='1792300000001'?'downloaded':'error');}
});
// Gitee serves byte ranges of the identical package, not a separately rebuilt installer.
test('Gitee parts assemble in order; portable parts never install',async t=>{
 for(const installed of [true,false]){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-parts-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const states=[],opened=[],installedFiles=[];
  const kind=installed?'installer':'portable',names=['part01','part02'];const r={...release(),id:42,assets:names.map((name,i)=>({name,size:2,browser_download_url:`https://gitee.com/attachments/download/${i+1}`}))};r.assets.push({name:'folia-hifi-update.json',browser_download_url:'https://gitee.com/attachments/download/3'});
  const m={...manifest(),parts:{[kind]:names.map(name=>({name,size:2}))}};
  const service=createForkUpdates({current,installed,directory,publish:s=>states.push(s),getSource:()=> 'gitee',openDownloaded:f=>opened.push(f),install:async f=>{installedFiles.push(f);return true;},fetcher:async url=>url.endsWith('/latest')?Response.json(r):url.endsWith('/attach_files')?Response.json(r.assets):url.includes('/3?')?Response.json(m):new Response(url.endsWith('/1')?'ab':'cd')});
  await service.check({manual:true});assert.equal(states.at(-1).status,'available');await service.download();assert.equal(states.at(-1).status,'downloaded');assert.equal(installedFiles.length,0);assert.equal(await service.confirmInstall(),installed);assert.equal(await fs.readFile(installed?installedFiles[0]:opened[0],'utf8'),'abcd');
  const missing={...r,assets:r.assets.filter(a=>a.name!=='part02')};assert.throws(()=>selectUpdate(missing,m,current,installed,'gitee'),/缺少完整分片/);
 }
});
test('interrupted second part never becomes an installable package; retry starts clean',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-parts-retry-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const states=[];let failing=true,installedFile;
 const r={...release(),id:42,assets:[{name:'p1',size:2,browser_download_url:'https://gitee.com/attachments/download/1'},{name:'p2',size:2,browser_download_url:'https://gitee.com/attachments/download/2'},{name:'folia-hifi-update.json',browser_download_url:'https://gitee.com/attachments/download/3'}]};const m={...manifest(),parts:{installer:[{name:'p1',size:2},{name:'p2',size:2}]}};
 const service=createForkUpdates({current,installed:true,directory,publish:s=>states.push(s),getSource:()=> 'gitee',install:async f=>{installedFile=f;return true;},fetcher:async url=>{if(url.endsWith('/latest'))return Response.json(r);if(url.endsWith('/attach_files'))return Response.json(r.assets);if(url.includes('/3?'))return Response.json(m);if(url.endsWith('/2')&&failing)throw Error('测试中断');return new Response(url.endsWith('/1')?'ab':'cd');}});
 await service.check();await service.download();assert.equal(states.at(-1).status,'error');assert.equal(await service.confirmInstall(),false);failing=false;await service.download();assert.equal(await service.confirmInstall(),true);assert.equal(await fs.readFile(installedFile,'utf8'),'abcd');
});
test('release splitting retains every original byte and publishes one manifest for both hosts',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-split-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const r={forkTag:current.forkTag,build:current.build,productName:'Folia',version:'0.7.19'};
 for(const name of ['Folia-0.7.19-win-x64-Setup.exe','Folia-0.7.19-win-x64.zip'])await fs.writeFile(path.join(directory,name),'abcdefg');
 const m=await require('../../packaging/exclusive/updateManifest.cjs').prepareUpdateArtifacts(directory,r,3);
 for(const kind of ['installer','portable']){assert.deepEqual(m.parts[kind].map(p=>p.size),[3,3,1]);assert.equal(Buffer.concat(await Promise.all(m.parts[kind].map(p=>fs.readFile(path.join(directory,p.name))))).toString(),'abcdefg');}
});

