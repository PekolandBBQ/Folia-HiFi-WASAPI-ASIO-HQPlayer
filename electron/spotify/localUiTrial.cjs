'use strict';
const fs=require('node:fs'),path=require('node:path');
// Local full-Folia trial: the normal Omni/IPC/player path owns all playback operations.
const live=path.join(__dirname,'wrapper');
const {createBridge}=require('./wrapper/bridge.cjs');
const {createLocalSource}=require('./wrapper/source.cjs');
const runtimePaths=()=>require('./wrapperPaths.cjs').wrapperPaths({resourcesPath:process.resourcesPath,profile:require('electron').app.getPath('userData')});
let shared;
function initialize(log){
  if(shared)return shared;
  const bridge=createBridge(log,{secretPath:path.join(require('electron').app.getPath('userData'),'spotify','local-bridge.key')}), source=createLocalSource(bridge,log), catalog=new Map();
  source.setPath(process.env.FOLIA_LOCAL_CONTROL_PATH||'wrapper');
  const cache=path.join(require('electron').app.getPath('userData'),'spotify','local-catalog.json');
  const locations=runtimePaths();
  let activeApps=locations.readApps(),sessionExtension;
  const apps=()=>activeApps;
  const activateApps=async value=>{locations.saveApps(value);activeApps=value;};
  try{for(const item of JSON.parse(fs.readFileSync(cache,'utf8')))catalog.set(item.id,item);}catch{}
  const ready=bridge.start().then(config=>{
    const extension=fs.readFileSync(path.join(live,'extension.js'),'utf8').replace('__FOLIA_LIVE_URL__',JSON.stringify(config.url));sessionExtension=extension;
    const extensionPath=path.join(apps(),'xpui/extensions/folia-live-bridge.js');
    if(fs.existsSync(path.dirname(extensionPath)))fs.writeFileSync(extensionPath,extension);
    log('ui-bridge-ready',{controlPath:process.env.FOLIA_LOCAL_CONTROL_PATH||'wrapper',officialRequestsEnabled:false});
  });
  async function refresh(){await ready;if(!bridge.connected())return [...catalog.values()];await source.sample();const result=await bridge.request('catalog');
    for(const item of result.tracks)catalog.set(item.id,item);
    fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,JSON.stringify([...catalog.values()]));
    log('ui-local-catalog',{tracks:catalog.size,queueKeys:result.queueKeys,queueShape:result.queueShape});return [...catalog.values()];}
  const electron=require('electron');
  const desktop=require('./desktopLifecycle.cjs').createDesktopLifecycle({directory:path.dirname(cache),apps,bridge,ready,log,dialog:electron.dialog,parent:()=>electron.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed())});
  shared={bridge,source,catalog,ready,refresh,desktop,apps,activateApps,extension:async()=>{await ready;return sessionExtension;}};return shared;
}
function registerLocalUiTrial(options){
  const log=global.__foliaTrialLog||((event,facts)=>{
    if(['bridge-upgrade-rejected','spotify-connection-unavailable','spotify-auto-reconnect','spotify-background-ready','spotify-background-failed','bridge-connected'].includes(event)){
      try{const directory=path.join(require('electron').app.getPath('userData'),'spotify','diagnostics');fs.mkdirSync(directory,{recursive:true});fs.appendFileSync(path.join(directory,'connection.jsonl'),JSON.stringify({at:Date.now(),event,...facts})+'\n');}catch{}
    }
    if(['spotify-orphan-route-restored','spotify-background-retained','spotify-background-exit','spotify-background-exit-failed','spotify-resource-version','bridge-connected','bridge-disconnected','bridge-request-failed','bridge-runtime','spotify-background-failed','ui-online-search'].includes(event))
      require('../debug/debugHost.cjs').runtimeLine('SpotifyBridge',JSON.stringify({event,...facts}));
  }), local=initialize(log);
  return require('./cableService.cjs').registerCableSpotify({...options,connectionMode:'wrapper',createService:settings=>createService(settings,local,log)});
}
function createService({beforeLeaveProvider},local,log){
  const {source,bridge,catalog,refresh,desktop}=local;
  const profile=require('electron').app.getPath('userData'),setupFile=path.join(profile,'spotify/cable-setup.json');
  let setup={selection:{connectDeviceId:'',captureDeviceId:'',renderDeviceId:'',internal44100Confirmed:false,spotifyOnlyConfirmed:false,defaultsConfirmed:false}};
  try{setup=JSON.parse(fs.readFileSync(setupFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  // Match cableSetup's automatic-route schema migration; do not create new confirmations.
  const saved={...setup.selection,spotifyOnlyConfirmed:setup.automaticRouteSchema===1&&setup.spotifyClientOutputConfirmed===true};
  async function configureEndpoints(endpoints){
    endpoints ||= (await capture.devices()).endpoints || [];
    const pair=require('./cableEndpointSelection.cjs').selectCableEndpoints(endpoints,saved);
    if(!pair)throw Object.assign(Error('SPOTIFY_CABLE_SELECTION_REQUIRED'),{code:'SPOTIFY_CABLE_SELECTION_REQUIRED'});
    const changed=saved.captureDeviceId!==pair.captureDeviceId||saved.renderDeviceId!==pair.renderDeviceId;
    Object.assign(saved,pair);
    // Discover endpoint IDs only: format/routing authority is established by real playback.
    if(!changed&&setup.automaticRouteSchema===1)return pair;
    fs.mkdirSync(path.dirname(setupFile),{recursive:true});
    fs.writeFileSync(setupFile+'.tmp',JSON.stringify({schema:1,enabled:true,selection:saved,automaticRouteSchema:1,spotifyClientOutputConfirmed:false}));
    fs.renameSync(setupFile+'.tmp',setupFile);
    log('spotify-endpoints-configured',{selectedVerifiedPair:true});
    setup.automaticRouteSchema=1;
    return pair;
  }
  const vault={stamp:source.stamp,token:async()=>{throw Error('Official HTTP disabled');},grantedScopes:async()=>{throw Error('Official scopes must not be used by local source');}},cooldown={load:async()=>0,defer:async()=>{throw Error('Official HTTP disabled');}};
  let control,audio,closing,externalPrompt=0,launchIntent=0;
  const externalSelection=async facts=>{
    const prompt=++externalPrompt;
    const output=await beforeLeaveProvider();await output?.complete?.();
    await refresh();
    const {BrowserWindow,dialog}=require('electron');
    const windows=BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed());
    const send=value=>windows.forEach(w=>{if(!w.isDestroyed())w.webContents.send('spotify:external-selection',value);});
    send({phase:'paused',trackId:facts.trackId,positionMs:facts.positionMs});
    const name=catalog.get(facts.trackId)?.name||'Spotify 当前歌曲';
    const choice=await dialog.showMessageBox(windows[0],{type:'question',title:'Spotify 已在桌面换歌',
      message:`已暂停“${name}”并停止采集。是否追随 Spotify 的歌曲和进度？`,
      detail:'暂不追随：双方保持暂停并保留路由。在 Spotify 中继续：恢复原输出路由，由 Spotify 播放。',
      buttons:['追随 Spotify','暂不追随','在 Spotify 中继续播放'],defaultId:1,cancelId:1});
    if(prompt!==externalPrompt||closing)return;
    const actual=await source.sample();
    if(choice.response===0&&actual.uri==='spotify:track:'+facts.trackId&&!actual.isPlaying){
      send({phase:'follow',trackId:facts.trackId,positionMs:actual.positionMs});
      log('ui-external-follow',{trackId:facts.trackId,positionMs:actual.positionMs});
    }else if(choice.response===2&&actual.uri==='spotify:track:'+facts.trackId&&!actual.isPlaying){
      // Explicit hand-back ends Folia's source ownership before Spotify can produce audio.
      await leave();
      desktop.handBack();
      const stamp=source.stamp();
      const current=()=>{if(closing||prompt!==externalPrompt||JSON.stringify(source.stamp())!==JSON.stringify(stamp))
        throw Object.assign(Error('SESSION_CHANGED'),{code:'SESSION_CHANGED'});};
      await source.request('play',{deviceId:actual.deviceId,trackId:facts.trackId},current,{matchTrackBeforeDispatch:true});
      const until=Date.now()+4000;let playing;
      do{current();playing=await source.sample();if(playing.uri!=='spotify:track:'+facts.trackId)throw Error('TRACK_NOT_CURRENT');
        if(playing.isPlaying)break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<until);
      if(!playing.isPlaying)throw Error('PLAYBACK_STATE_UNCONFIRMED');
      log('ui-external-spotify-continued',{trackId:facts.trackId,positionMs:playing.positionMs,originalRouteRestored:true});
    }else log('ui-external-follow-declined',{trackId:facts.trackId,changedAgain:actual.uri!=='spotify:track:'+facts.trackId});
  };
  const capture=require('./cableCaptureHost.cjs').createCableCaptureHost({helperPath:process.env.FOLIA_LOCAL_CAPTURE_HELPER || runtimePaths().capture,fastInitialEpoch:true,requireProcessCapture:true,onDiagnostic:d=>log('capture',d),onControlDiagnostic:d=>log('capture-control',d)});
  const showOutputGuide=()=>{for(const w of require('electron').BrowserWindow.getAllWindows())if(!w.isDestroyed())w.webContents.send('spotify:setup-required');};
  const host=require('./ownedRouteHost.cjs').createOwnedRouteHost({processCapture:true,componentDirectory:process.env.FOLIA_LOCAL_ROUTE_COMPONENT || runtimePaths().route,onConfigurationRequired:showOutputGuide,onSourceControl:(i,o)=>control.routeSourceControl(i,o)});host.setTrialEnabled(true);
  const request=host.request.bind(host);host.request=async(c,p)=>{try{return await request(c,p);}catch(e){log('route-request-failed',{command:c,code:e.code,failureCode:e.failureCode});throw e;}};
  const route=require('./ownedRouteLifecycle.cjs').createOwnedRouteLifecycle({host,onDiagnostic:d=>log('route',d)});
  const capability=route.availability();
  void Promise.all([capture.supportsPositionEpoch(),capability]).catch(e=>log('ui-prewarm-failed',{code:e.code}));
  control=require('./desktopPlaybackControl.cjs').createDesktopPlaybackControl({vault,cooldown,createSourceApi:()=>source,reuseColdTrack:true,settleIntervalMs:50,selectionTimeoutMs:30000,
    readRoutePcmEvidence:(s,g)=>route.pcmStopped(s,g),readSeekParkEvidence:(s,g,t,k)=>route.seekParkEvidence(s,g,t,k),
    onRevoke:value=>audio?.revokeSession(value.session,value.code),onFailureDiagnostic:e=>log('control-original-failure',{code:e.code,diagnostic:e.diagnostic})});
  audio=require('./cableAudioPreparation.cjs').createCableAudioPreparation({captureHost:capture,control,vault,cooldown,routeLifecycle:route,
    onExternalSelection:externalSelection,
    localSourceMetadata:async id=>{await refresh();const t=catalog.get(id);if(!t)throw Object.assign(Error('TRACK_NOT_CURRENT'),{code:'TRACK_NOT_CURRENT'});return {trackId:id,durationMs:t.durationMs};},
    fetcher:async()=>{throw Error('Official HTTP disabled');},getSelection:async()=>{

      const [sample,devices]=await Promise.all([source.sample(),capture.devices()]);
      const output=require('./systemOutputCheck.cjs').systemOutputCheck(devices);
      // Exact Spotify route inspection owns the decision; a missing global default alone is not a playback failure.
      if(output.state!=='ready')log('system-output-advisory',{state:output.state});
      const pair=await configureEndpoints(devices.endpoints);
      return {deviceId:sample.deviceId,...pair,temporaryFormatLease:true,automaticRouting:true};
    },onDiagnostic:d=>log('audio-source',d)});
  const browser=require('./soloistBrowserSession.cjs').createSoloistBrowserSession({lookup:url=>audio.lookup(url)});
  const pausedObserver=setInterval(()=>{if(!closing)void audio.observePausedExternalSelection().catch(e=>log('ui-external-observation-failed',{code:e.code}));},2000);
  pausedObserver.unref?.();
  const song=t=>({id:t.id,name:t.name,durationMs:t.durationMs,artists:[{id:'',name:t.artist}],album:{id:'',name:t.album,coverUrl:t.coverUrl},sourceRef:{kind:'online',providerId:'spotify',mediaId:t.id,providerData:{sessionBoundAudio:true,metadataSource:'spicetify-local',uri:'spotify:track:'+t.id}}});
  async function leave(){const output=await beforeLeaveProvider();await browser.clear();await audio.leaveProvider('provider-exit');await output?.complete?.();}
  return {
    async request(input,progress){
      log('ui-spotify-request',{action:input.action,operation:input.operation,trackId:input.action==='audio'?input.id:undefined});
      if(input.action==='desktopSetup'&&input.operation==='preferences')return input.preferences?desktop.setPreferences(input.preferences):desktop.preferences();
      if(input.action==='desktopSetup')return require('./desktopSetupGuide.cjs').request({input,progress,beforeConfigure:leave,desktop,bridge,apps:local.apps,capture,route,directory:path.join(profile,'spotify'),assetDirectory:runtimePaths().assetRoot,existingCli:process.env.FOLIA_WRAPPER_EXISTING_CLI,extension:local.extension,activateApps:local.activateApps,configureEndpoints,endpointsConfigured:endpoints=>Boolean(require('./cableEndpointSelection.cjs').selectCableEndpoints(endpoints,saved)),log});
      if(input.action==='audio'){
        const intent=++launchIntent;
        const current=()=>{if(closing||intent!==launchIntent)throw Object.assign(Error('CANCELLED'),{code:'CANCELLED'});};
        await desktop.ensure(progress);current();let prepared;
        const recovery=require('./orphanRouteRecovery.cjs');
        prepared=await recovery.prepareWithOrphanRecovery(()=>audio.prepare(input.id,input.requestId,progress,input.quality),
          ()=>recovery.recoverOrphanRoute({componentDirectory:process.env.FOLIA_LOCAL_ROUTE_COMPONENT||runtimePaths().route,source,current,log}),current);
        require('./playbackHealth.cjs').prepared();return prepared;
      }
      if(input.action==='cancelAudio'){launchIntent++;audio.cancel(input.requestId);return null;}
      if(input.action==='logout'){await leave();return null;}
      if(input.action==='lyrics'){
        await local.ready;
        if(!catalog.has(input.id))await refresh();
        const result=await require('./wrapper/lyrics.cjs').requestNativeLyrics(bridge,{trackId:input.id,imageUrl:catalog.get(input.id)?.coverUrl},log);
        log('ui-native-lyrics',{trackId:input.id,source:result.source,syncType:result.syncType,lineCount:result.lines.length});
        return result;
      }
      if(input.action==='leaveProvider'){await leave();await desktop.offerExit('source');return null;}
      if(input.action==='status'){await desktop.ensure(progress);const s=await source.sample();return {id:s.account,display_name:s.displayName||s.account,images:s.images||[]};}
      if(input.action==='playbackSetup'){
        if(!['status','devices'].includes(input.operation))throw Object.assign(Error('SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC'),{code:'SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC'});
        const s=await source.sample(),c=await route.availability(),devices=await capture.devices();
        const pair=require('./cableEndpointSelection.cjs').selectCableEndpoints(devices.endpoints||[],saved);
        if(pair)await configureEndpoints(devices.endpoints);
        const present=Boolean(pair);
        return {backend:'vb-cable',state:'stopped',code:'AUTOMATIC_ROUTE_ON_PLAY',driverInstalled:present===true,spotifyRunning:true,
          selection:{...saved,connectDeviceId:s.deviceId},devices:{spotify:[{id:s.deviceId,name:'本机 Spotify',type:'Computer',isActive:s.isActive,restricted:s.restricted,selectable:s.restricted===false}],capture:devices.endpoints.filter(e=>e.supportedBaseCable&&e.flow==='capture'),render:devices.endpoints.filter(e=>e.supportedBaseCable&&e.flow==='render')},automaticRoute:{enabled:true,supported:c.supported,eligible:c.supported,productionQualified:false,trialAvailable:true,trialAuthorized:true}};
      }
      if(['search','likeSong','savedTracks'].includes(input.action)){
        await local.ready;await desktop.ensure(progress);
        if(['search','likeSong'].includes(input.action))await require('./wrapper/handshake.cjs').requireHandshake(bridge);
        if(input.action==='savedTracks'){
          const result=await bridge.request('likedTracks',{offset:input.offset||0,limit:input.limit||50});
          for(const t of result.items)catalog.set(t.id,t);
          log('ui-local-liked-tracks',{count:result.items.length,total:result.total,consumed:result.consumed,coverCount:result.items.filter(t=>t.coverUrl).length,hasMore:Boolean(result.next)});
          return {...result,items:result.items.map(song)};
        }
        if(input.action==='search'){
          const result=await bridge.request('searchTracks',{query:input.query,offset:input.offset,limit:input.limit,
            definition:require('./wrapper/searchDefinition.cjs').readSearchDefinition(local.apps())});
          for(const t of result.items)catalog.set(t.id,t);
          log('ui-online-search',{offset:input.offset||0,count:result.items.length,total:result.total,next:result.next});
          return {...result,items:result.items.map(song)};
        }
        const result=await bridge.request('setLiked',{trackId:input.id,liked:input.liked});
        if(result?.confirmed!==true||result.trackId!==input.id||result.liked!==input.liked)throw Object.assign(Error('LIBRARY_WRITE_UNCONFIRMED'),{code:'LIBRARY_WRITE_UNCONFIRMED'});
        log('ui-liked-write',{trackId:input.id,liked:input.liked,confirmed:true});return result;
      }
      const tracks=await refresh(), offset=input.offset||0,limit=input.limit||50;
      const page=items=>({items:items.slice(offset,offset+limit),total:items.length,next:offset+limit<items.length?'local-next':null});
      if(input.action==='song'){const t=catalog.get(input.id);if(!t)throw Error('Spotify: local-metadata-unavailable');return song(t);}
      const collection={id:'folia-local-queue',providerId:'spotify',name:'本机 Spotify 已加载曲目',description:'当前曲目与本机队列；不调用官方目录接口',coverUrl:tracks.find(t=>t.coverUrl)?.coverUrl,trackCount:tracks.length,providerData:{localQueue:true},type:'playlist'};
      if(input.action==='playlists')return {items:[collection],total:1,next:null};
      if(input.action==='playlist')return collection;
      if(input.action==='playlistTracks')return page(tracks.map(song));
      throw Error('Spotify: local-trial-operation-unavailable');
    },
    async prepareSourceOutput(url,backend){if(audio.lookup(url)){return;}await leave();await desktop.offerExit('source');},
    lookupSoloistPcmSource:url=>audio.lookup(url),requestBrowserPcm:input=>browser.request(input),
    canRetryClose:()=>true,
    close(){if(closing)return closing;externalPrompt++;closing=(async()=>{await leave();await audio.clear();await route.releaseBeforeClose();await capture.close();route.captureHelperExited();await route.close();await control.dispose();await desktop.offerExit('quit');clearInterval(pausedObserver);bridge.close();log('quit-restoration-complete',{});})();closing.catch(()=>{closing=null;});return closing;},
  };
}
module.exports={registerLocalUiTrial};
