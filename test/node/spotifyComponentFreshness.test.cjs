'use strict';
const { test }=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {zipSync}=require('fflate');
const {acquirePackage,digest}=require('../../electron/spotify/componentPackage.cjs');
const {latestComponentBundle,compareVersions}=require('../../electron/spotify/latestComponentBundle.cjs');
const {createComponentInstall}=require('../../electron/spotify/componentInstall.cjs');
const bundle=require('../../electron/spotify/componentBundle.json');
// Version, integrity and orchestration checks use synthetic data, never driver installation.
async function directory(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'folia-component-freshness-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.ok(path.basename(root).startsWith('folia-component-freshness-'));await fs.rm(root,{recursive:true,force:true});});
  return root;
}
test('all vendor files must match before reuse; missing helper repairs while retaining the old package',async t=>{
  const root=await directory(t),files={'spicetify.exe':Buffer.from('exe'),'jsHelper/spicetifyWrapper.js':Buffer.from('wrapper'),'css-map.json':Buffer.from('{}')};
  const bytes=Buffer.from(zipSync(files)),pin={version:'2.45.3',sha256:digest(bytes),entry:'spicetify.exe',entrySha256:digest(files['spicetify.exe']),wrapperSha256:digest(files['jsHelper/spicetifyWrapper.js']),url:'https://fixture.invalid'};
  let downloads=0;
  const fetcher=async()=>{downloads++;return {ok:true,body:[bytes]}};
  const installed=await acquirePackage(pin,root,{fetcher});
  assert.equal(await acquirePackage(pin,root,{fetcher}),installed);assert.equal(downloads,1);
  await fs.unlink(path.join(installed,'css-map.json'));
  await acquirePackage(pin,root,{fetcher});
  assert.equal(downloads,2);assert.equal(await fs.readFile(path.join(installed,'css-map.json'),'utf8'),'{}');
  assert.equal((await fs.readdir(root)).filter(x=>x.includes('.retained-')).length,1);
});
test('old package receipt without full file checks is upgraded, never accepted by presence',async t=>{
  const root=await directory(t),files={'spicetify.exe':Buffer.from('exe')},bytes=Buffer.from(zipSync(files));
  const pin={version:'1.0.0',sha256:digest(bytes),entry:'spicetify.exe',url:'https://fixture.invalid'};
  const destination=path.join(root,pin.version+'-'+pin.sha256.slice(0,12));
  await fs.mkdir(destination);await fs.writeFile(path.join(destination,pin.entry),files[pin.entry]);
  await fs.writeFile(path.join(destination,'folia-package.json'),JSON.stringify({archiveSha256:pin.sha256,entrySha256:digest(files[pin.entry])}));
  let downloads=0;await acquirePackage(pin,root,{fetcher:async()=>{downloads++;return {ok:true,body:[bytes]}}});
  assert.equal(downloads,1);assert.ok(JSON.parse(await fs.readFile(path.join(destination,'folia-package.json'),'utf8')).files);
});
test('bundle precedence handles stable releases and numeric preview revisions',()=>{
  assert.ok(compareVersions('0.1.0','0.1.0-preview.4')>0);
  assert.ok(compareVersions('0.1.0-preview.10','0.1.0-preview.4')>0);
  assert.ok(compareVersions('0.2.0-preview.1','0.1.0')>0);
  assert.equal(compareVersions(bundle.version,bundle.version),0);
});
function releaseFetcher(published,asset=true) {
  const requests=[];
  return {requests,fetcher:async url=>{
    requests.push(url);
    return {ok:true,json:async()=>url.includes('/releases/latest')?{tag_name:'folia-hifi-v0.7.19-r1',draft:false,prerelease:false,assets:asset?[{name:'spotify-wrapper-components.json',browser_download_url:'https://fixture.invalid/manifest'}]:[]}:published};
  }};
}
test('latest release manifest is fetched on each call and older published bundle does not downgrade this app',async()=>{
  const f=releaseFetcher({...bundle,version:'0.1.0-preview.3'});
  for(let index=0;index<2;index++) assert.equal((await latestComponentBundle({fetcher:f.fetcher})).bundle.version,bundle.version);
  assert.equal(f.requests.length,4);
});
test('r4 without a manifest asset uses its tagged source manifest',async()=>{
  const f=releaseFetcher(bundle,false);await latestComponentBundle({fetcher:f.fetcher});
  assert.match(f.requests[1],/raw.githubusercontent.com.*componentBundle.json$/);
});
test('same-version release replacement cannot silently retain the old native pair',async()=>{
  const replaced={...bundle,route:{...bundle.route,sha256:'a'.repeat(64)}};
  await assert.rejects(latestComponentBundle({fetcher:releaseFetcher(replaced).fetcher}),{code:'SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED'});
});

test('same-version candidate keeps its newer revision until release replacement; old apps detect the update',async()=>{
  const older={...bundle,revision:0,route:{...bundle.route,sha256:'b'.repeat(64)}};
  assert.equal((await latestComponentBundle({fetcher:releaseFetcher(older).fetcher})).bundle.revision,1);
  await assert.rejects(latestComponentBundle({fetcher:releaseFetcher(bundle).fetcher,bundled:older}),{code:'SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED'});
});
test('a newer validated pin is selected; a native ABI change requires matching Folia',async()=>{
  const newer={...bundle,version:'0.1.0-preview.5',spicetify:{...bundle.spicetify,version:'2.46.0'}};
  assert.equal((await latestComponentBundle({fetcher:releaseFetcher(newer).fetcher})).bundle.spicetify.version,'2.46.0');
  await assert.rejects(latestComponentBundle({fetcher:releaseFetcher({...newer,route:{...bundle.route,version:'next'}}).fetcher}),{code:'SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED'});
});
test('update check network failure stops without calling any installer',async t=>{
  const root=await directory(t),calls=[];
  const manager=createComponentInstall({directory:root,inspect:async()=>({}),checkLatest:async()=>{throw Object.assign(Error('offline'),{code:'SPOTIFY_COMPONENT_UPDATE_CHECK_FAILED'})},installSpicetify:async()=>calls.push('install')});
  manager.start('install');await manager.settled();
  assert.equal((await manager.status()).code,'SPOTIFY_COMPONENT_UPDATE_CHECK_FAILED');assert.deepEqual(calls,[]);
});
test('an installed CLI is still verified on every install; same driver is kept',async t=>{
  const root=await directory(t),calls=[];
  const current={installations:[{}],selected:'desktop',engine:true,cli:true,driver:true,driverCurrent:true};
  const manager=createComponentInstall({directory:root,inspect:async()=>current,checkLatest:async()=>calls.push('latest'),installSpicetify:async()=>calls.push('verify'),installDriver:async()=>calls.push('driver')});
  for(let index=0;index<2;index++){manager.start('install');await manager.settled();}
  assert.deepEqual(calls,['latest','verify','latest','verify']);assert.equal((await manager.status()).phase,'installed');
});
test('an older driver requires its update and a Windows restart',async t=>{
  const root=await directory(t),calls=[];
  const current={installations:[{}],selected:'desktop',engine:true,cli:true,driver:true,driverCurrent:false};
  const manager=createComponentInstall({directory:root,inspect:async()=>current,checkLatest:async()=>{},installSpicetify:async()=>{},installDriver:async()=>calls.push('driver')});
  manager.start('install');await manager.settled();assert.deepEqual(calls,['driver']);
  assert.equal((await manager.status()).restartRequired,true);
  manager.start('install');await manager.settled();assert.deepEqual(calls,['driver']);assert.equal((await manager.status()).phase,'restart-required');
});
