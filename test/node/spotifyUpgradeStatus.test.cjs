'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { upgradeAssets } = require('../../electron/spotify/upgradeAssets.cjs');
const { digest } = require('../../electron/spotify/componentPackage.cjs');
const { failureDetails } = require('../../electron/spotify/failureDetails.cjs');
test('paused cleanup errors keep their concrete Chinese cause across public mapping',()=>{
 for (const code of ['PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED','PAUSED_SOURCE_SESSIONS_STILL_ACTIVE',
   'PAUSED_SOURCE_OBSERVATION_INVALID','PAUSED_SOURCE_OBSERVATION_TIMEOUT','PCM_STOP_NOT_CONFIRMED',
   'PAUSED_SOURCE_SCAN_INCOMPLETE','PAUSED_SOURCE_PROCESS_MISMATCH','PAUSED_SOURCE_OBSERVATION_STALE',
   'PAUSED_SOURCE_OBSERVATION_IN_FUTURE','PAUSED_SOURCE_SESSION_ID_MISSING']) {
  const value=failureDetails(publicError(Object.assign(Error(code),{code,stage:'cleanup'})),'audio');
  assert.equal(value.nativeCode,code);assert.equal(value.stage,'cleanup');
  assert.doesNotMatch(value.detail,/以下为组件返回的具体错误/);assert.match(value.detail,/[\u4e00-\u9fff]/);
 }
});
const { publicError } = require('../../electron/spotify/cableAudioFacts.cjs');
const { createSpotifyRuntime } = require('../../electron/spotify/runtime.cjs');
// Regression fixtures use isolated assets; no real Spotify, backup, driver or account is changed.
async function root(t) { const value = await fs.mkdtemp(path.join(os.tmpdir(),'folia-upgrade-status-')); t.after(async()=>{assert.equal(path.dirname(value),os.tmpdir());assert.ok(path.basename(value).startsWith('folia-upgrade-status-'));await fs.rm(value,{recursive:true,force:true});});return value; }
for (const layout of ['store','desktop']) test(layout + ' old resources upgrade with apply only and retain original backup',async t=>{
 const directory = await root(t), old = path.join(directory,'old'), config = path.join(old,'roaming/spicetify');
 const apps = layout === 'store' ? path.join(config,'AppX') : path.join(old,'spotify/Apps');
 for (const suffix of ['Backup','Extensions']) await fs.mkdir(path.join(config,suffix),{recursive:true});
 await fs.mkdir(path.join(apps,'xpui/helper'),{recursive:true});
 await fs.writeFile(path.join(config,'Backup/xpui.spa'),'original backup');
 await fs.writeFile(path.join(config,'config-xpui.ini'),'spotify_path = '+path.join(old,'spotify'));
 await fs.writeFile(path.join(apps,'xpui/helper/spicetifyWrapper.js'),'old wrapper');
 await fs.writeFile(path.join(old,'configuration.json'),JSON.stringify({installation:layout,stage:'configured',bundleVersion:'old'}));
 const calls=[], wrapper='new wrapper';
 const result=await upgradeAssets({apps,assetDirectory:directory,target:{id:layout,layout},cli:directory,extension:'new extension',bundle:{version:'new',spicetify:{wrapperSha256:digest(Buffer.from(wrapper))}},execute:async(_exe,args,env)=>{
  calls.push(args.at(-1)); assert.ok(!(await fs.readFile(path.join(env.SPICETIFY_CONFIG,'config-xpui.ini'),'utf8')).includes(old));
  const target=layout==='store'?path.join(env.SPICETIFY_CONFIG,'AppX'):path.join(env.USERPROFILE,'spotify/Apps');
  await fs.mkdir(path.join(target,'xpui/extensions'),{recursive:true});
  await fs.writeFile(path.join(target,'xpui/index.html'),'helper/spicetifyWrapper.js extensions/folia-live-bridge.js');
  await fs.writeFile(path.join(target,'xpui/xpui.js'),'xpui');
  await fs.writeFile(path.join(target,'xpui/helper/spicetifyWrapper.js'),wrapper);
  await fs.writeFile(path.join(target,'xpui/extensions/folia-live-bridge.js'),'new extension');
 }});
 assert.deepEqual(calls,['apply']);assert.notEqual(result,apps);
 assert.equal(await fs.readFile(path.join(config,'Backup/xpui.spa'),'utf8'),'original backup');
 assert.equal(await fs.readFile(path.join(apps,'xpui/helper/spicetifyWrapper.js'),'utf8'),'old wrapper');
});
test('raw route cause survives public mapping and is shown instead of a generic preparation failure',()=>{
 const mapped=publicError(Object.assign(Error('ignored'),{code:'BOOTSTRAP_IDENTITY_UNCONFIRMED',failureCode:'ORIGINAL_PHYSICAL_OWNER_UNPROVEN',stage:'identity-inspect'}));
 const details=failureDetails(mapped,'audio');assert.equal(details.causeCode,'ORIGINAL_PHYSICAL_OWNER_UNPROVEN');assert.match(details.detail,/原输出/);assert.match(details.detail,/identity-inspect/);
});
test('Wrapper identifies its settings mode and rejects obsolete OAuth saves without touching service',async t=>{
 const directory=await root(t);let created=0;
 const runtime=createSpotifyRuntime({directory,connectionMode:'wrapper',environment:{},createService:()=>{created++;}});
 assert.equal((await runtime.request({action:'configuration'})).playbackMode,'wrapper');
 await assert.rejects(runtime.request({action:'configure',settings:{mode:'shared'}}),{code:'SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC'});assert.equal(created,0);
});

test('connected socket without a ready Spotify player is not reported as connected',async t=>{
 const directory=await root(t);
 const {createGuide}=require('../../electron/spotify/desktopSetupGuide.cjs');
 const guide=createGuide({directory,apps:()=>path.join(directory,'missing'),desktop:{inspect:async()=>({candidates:[{id:'local',version:'test',layout:'desktop'}],selected:'local',errors:[],running:[{}]})},
 bridge:{connected:()=>true,request:async()=>({local:true,wrapperReady:false,account:'test',deviceId:'test'})},capture:{devices:async()=>({endpoints:[]})},route:{availability:async()=>({supported:true})},endpointsConfigured:()=>false,extension:async()=>'',log:()=>{}});
 const result=await guide.request({operation:'status'});assert.equal(result.connected,false);assert.equal(result.ready,false);assert.ok(result.issues.some(i=>i.nativeCode==='SPOTIFY_PLAYER_NOT_READY'));
});
test('capture failure remains visible even when the routing component is available',async t=>{
 const directory=await root(t);const {createGuide}=require('../../electron/spotify/desktopSetupGuide.cjs');
 const guide=createGuide({directory,apps:()=>path.join(directory,'missing'),desktop:{inspect:async()=>({candidates:[],errors:[],running:[]})},bridge:{connected:()=>false},capture:{devices:async()=>{throw Object.assign(Error('no helper'),{code:'CAPTURE_HELPER_UNAVAILABLE'})}},route:{availability:async()=>({supported:true})},endpointsConfigured:()=>false,extension:async()=>'',log:()=>{}});
 const result=await guide.request({operation:'status'});assert.equal(result.ready,false);assert.equal(result.engine,false);assert.ok(result.issues.some(i=>i.nativeCode==='CAPTURE_HELPER_UNAVAILABLE'));
});
