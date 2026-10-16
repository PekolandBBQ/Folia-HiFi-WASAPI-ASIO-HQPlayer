'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile,spawn}=require('node:child_process');
const {desktopScriptPath}=require('./desktopScriptPath.cjs');
// Spotify startup belongs to one installation and one Folia-owned process lifetime.
const failure=code=>Object.assign(Error(code),{code});
function discover(){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',desktopScriptPath('desktopDiscovery.ps1')],{windowsHide:true,timeout:15000},(e,out)=>{if(e)return reject(failure('SPOTIFY_DISCOVERY_FAILED'));try{resolve(JSON.parse(out));}catch{reject(failure('SPOTIFY_DISCOVERY_FAILED'));}}));}
function select(catalog,selected){
 const candidate=catalog.candidates.find(x=>x.id===selected);
 if(candidate)return candidate;
 if(selected)throw failure('SPOTIFY_SELECTED_INSTALL_MISSING');
 if(catalog.errors?.length)throw failure('SPOTIFY_DISCOVERY_FAILED');
 if(!catalog.candidates.length)throw failure('SPOTIFY_NOT_INSTALLED');
 if(catalog.candidates.length!==1)throw failure('SPOTIFY_INSTALL_CHOICE_REQUIRED');
 return catalog.candidates[0];
}
function createDesktopLifecycle({directory,apps,bridge,ready,log,dialog,parent,discovery=discover,start=spawn,stop=p=>process.kill(p.pid)}){
 const assetPath=()=>typeof apps==='function'?apps():apps;
 const file=path.join(directory,'desktop-installation.json');let selected,owned,starting;
 try{selected=JSON.parse(fs.readFileSync(file,'utf8')).id;}catch{}
 async function inspect(){const info=await discovery();let target;try{target=select(info,selected);}catch{}const bridgeRuntime=await require('./wrapper/handshake.cjs').inspectRuntime(bridge,info.running,assetPath());return {...info,selected:target?.id,owned:Boolean(owned),bridgeReady:bridgeRuntime.state==='ready',bridgeRuntime};}
 async function choose(id){const info=await discovery();if(!info.candidates.some(c=>c.id===id))throw failure('SPOTIFY_SELECTED_INSTALL_MISSING');selected=id;fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file,JSON.stringify({id}));return inspect();}
 async function run(progress=()=>{}){
  await ready;
  if(bridge.connected()){
   const handshake=await require('./wrapper/handshake.cjs').inspectHandshake(bridge);log('bridge-runtime',handshake);
   if(handshake.state==='ready'){const snapshot=await bridge.request('snapshot');
    if(snapshot.local&&snapshot.wrapperReady&&snapshot.account&&snapshot.deviceId)return;}
  }
  let info=await discovery();let target;
  try{target=select(info,selected);}catch(e){if(e.code==='SPOTIFY_NOT_INSTALLED')await dialog.showMessageBox(parent(),{type:'info',title:'需要安装 Spotify',message:'未检测到 Spotify 桌面版或 Microsoft Store 版。请自行安装并登录 Spotify，然后回到 Folia 重新检查。',buttons:['知道了']});throw e;}
  if(info.running.some(p=>p.exe.toLowerCase()!==target.exe.toLowerCase()))throw failure('SPOTIFY_OTHER_INSTALL_RUNNING');
  if(!fs.existsSync(path.join(assetPath(),'xpui','index.html')))throw failure('SPOTIFY_COMPONENT_SETUP_REQUIRED');
  const previousRuntime=await require('./wrapper/handshake.cjs').inspectRuntime(bridge,info.running,assetPath());
  if(['outdated','unmanaged','wrong-assets'].includes(previousRuntime.state)){
   progress({stage:'spotifyLaunch'});log('spotify-auto-reconnect',{reason:previousRuntime.state});
   await stopForConfiguration(true);info=await discovery();
  }
  if(!info.running.length){
   const launchedAt=Date.now();progress({stage:'spotifyLaunch'});
   let launchPid;
   if(target.layout==='store'){
    launchPid=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',desktopScriptPath('launchStore.ps1'),'-PackageFullName',target.packageFullName,'-Apps',assetPath()],{windowsHide:true,timeout:15000},(e,out)=>{if(e)return reject(failure('SPOTIFY_STORE_ACTIVATION_FAILED'));try{resolve(JSON.parse(out).activationPid);}catch{reject(failure('SPOTIFY_STORE_ACTIVATION_FAILED'));}}));
   }else{
    const child=start(target.exe,['--minimized','--app-directory='+assetPath()],{windowsHide:true,stdio:'ignore',detached:true});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(failure('SPOTIFY_START_FAILED')));});child.unref();launchPid=child.pid;
   }
   owned={exe:target.exe,launchedAt,pids:[]};log('spotify-background-launch',{layout:target.layout,pid:launchPid});
  }
  const loaded=await require('./wrapper/handshake.cjs').inspectRuntime(bridge,info.running,assetPath());
  if(['unmanaged','wrong-assets'].includes(loaded.state))throw failure('SPOTIFY_RESOURCE_DIRECTORY_MISSING');
  const deadline=Date.now()+30000;
  while(!bridge.connected()){if(Date.now()>deadline)throw failure('SPOTIFY_BRIDGE_NOT_READY');await new Promise(r=>setTimeout(r,100));}
  log('bridge-runtime',await require('./wrapper/handshake.cjs').inspectHandshake(bridge));
  // A connected extension can precede Spotify's restored local device/player.
  let playerReady=false;
  while(Date.now()<deadline){
   try{const snapshot=await bridge.request('snapshot');if(snapshot.local&&snapshot.wrapperReady&&snapshot.account&&snapshot.deviceId){playerReady=true;break;}}catch(e){if(!['CONTROL_REJECTED','DEVICE_INACTIVE','PLAYBACK_UNAVAILABLE'].includes(e.code))throw e;}
   await new Promise(r=>setTimeout(r,150));
  }
  if(!playerReady)throw failure('SPOTIFY_PLAYER_NOT_READY');
  if(owned){const current=await discovery();owned.pids=current.running.filter(p=>p.exe.toLowerCase()===owned.exe.toLowerCase()&&Date.parse(p.started)>=owned.launchedAt-1000);}
  log('spotify-background-ready',{owned:Boolean(owned)});
 }
 // Configuration restores Folia's audio route before stopping only the selected installation.
 async function stopForConfiguration(fromReconnect=false){
  if(starting&&!fromReconnect)await starting;
  const info=await discovery(),target=select(info,selected);
  if(info.running.some(p=>p.exe.toLowerCase()!==target.exe.toLowerCase()))throw failure('SPOTIFY_OTHER_INSTALL_RUNNING');
  for(const p of info.running){
   const fresh=await discovery();
   if(fresh.running.some(n=>n.pid===p.pid&&n.started===p.started&&n.exe.toLowerCase()===target.exe.toLowerCase())){
    try{await stop(p);}catch(e){if(e.code!=='ESRCH')throw Object.assign(failure('SPOTIFY_SETUP_STOP_FAILED'),{cause:e});}
   }
  }
  const deadline=Date.now()+10000;
  while((await discovery()).running.some(p=>p.exe.toLowerCase()===target.exe.toLowerCase())||bridge.connected()){
   if(Date.now()>deadline)throw failure('SPOTIFY_SETUP_STOP_TIMEOUT');
   await new Promise(r=>setTimeout(r,100));
  }
  owned=null;log('spotify-configuration-stopped',{processes:info.running.length});
 }
 return {inspect,choose,stopForConfiguration,ensure(progress){if(!starting)starting=run(progress).catch(e=>{log('spotify-background-failed',{code:e.code||'UNKNOWN',message:e.message});throw e;}).finally(()=>{starting=null;});return starting;},
  handBack(){owned=null;},
  async offerExit(reason){if(!owned)return;
   if(reason==='quit'){owned=null;log('spotify-background-retained',{reason});return;}
   const scope=owned;const info=await discovery();const matches=info.running.filter(p=>scope.pids.some(old=>old.pid===p.pid&&old.started===p.started));if(!matches.length){owned=null;return;}
   const result=await dialog.showMessageBox(parent(),{type:'question',title:'后台 Spotify',message:'已切换音源，是否同时退出由 Folia 拉起的 Spotify？',buttons:['保留 Spotify','同时退出 Spotify'],defaultId:0,cancelId:0});
   owned=null;
   if(result.response===1){const fresh=await discovery();for(const p of matches){if(fresh.running.some(n=>n.pid===p.pid&&n.started===p.started)){try{process.kill(p.pid);}catch(e){if(e.code!=='ESRCH')throw e;}}}log('spotify-background-exit',{reason,processes:matches.length});}
   else log('spotify-background-retained',{reason});
  }
 };
}
module.exports={createDesktopLifecycle,discover,select};
