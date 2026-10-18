/* Folia live local bridge. Configuration is supplied by the owning local Folia process. */
(()=>{
  'use strict';
  const panel=document.createElement('aside');panel.textContent='Folia 实播桥接：连接中';
  Object.assign(panel.style,{position:'fixed',right:'20px',top:'80px',zIndex:2147483647,background:'#172332',color:'white',padding:'16px'});
  document.body.append(panel);
  const bridgeUrl=__FOLIA_LIVE_URL__;let currentSocket, reconnectDelay=250;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const lyricsCache=new Map();let lyricsRateLimited=false;
  let libraryRateLimited=false, searchRateLimited=false, libraryWrites=Promise.resolve();
  // Native search and library operations stay independent of the playback command queue.
  const trackId=uri=>/^spotify:track:[A-Za-z0-9]{22}$/.test(uri||'')?uri.slice(14):null;
  function searchTrack(row){
    const t=row?.item?.data||row?.data||row?.item||row;
    const id=trackId(t?.uri);if(!id||typeof t.name!=='string')return null;
    const album=t.albumOfTrack||t.album||{},artists=t.artists?.items||t.artists||[];
    return {id,name:t.name,durationMs:t.duration?.totalMilliseconds??t.duration?.milliseconds??t.durationMs,
      artist:artists.map(a=>a.profile?.name||a.name||'').join(' / '),album:album.name||'',
      coverUrl:(album.coverArt?.sources||album.images?.items||album.images||[]).flat().map(i=>i.url).find(u=>typeof u==='string'&&u.startsWith('https://'))};
  }
  async function searchTracks(args){
    if(searchRateLimited)throw Error('SEARCH_RATE_LIMITED');
    const query=String(args.query||'').trim(),offset=Math.max(0,Math.floor(args.offset||0)),limit=Math.min(50,Math.max(1,Math.floor(args.limit||30)));
    if(!query)return {items:[],total:0,next:null,consumed:0};
    const graph=Spicetify.GraphQL,definition=graph?.Definitions?.searchTracks||args.definition;
    if(typeof graph?.Request!=='function'||definition?.name!=='searchTracks'||!/^[a-f0-9]{64}$/.test(definition.sha256Hash||''))throw Error('SEARCH_API_UNAVAILABLE');
    let result;
    try{result=await graph.Request(definition,{searchTerm:query,offset,limit,includePreReleases:false,includeAlbumPreReleases:false,includeAudiobooks:true,includeAuthors:false,includeEpisodeContentRatingsV2:false,numberOfTopResults:20});}
    catch(e){if(Number(e?.status??e?.statusCode)===429)searchRateLimited=true;throw Error(searchRateLimited?'SEARCH_RATE_LIMITED':'SEARCH_REQUEST_FAILED');}
    if(result?.errors?.length)throw Error('SEARCH_REQUEST_FAILED');
    const page=result?.data?.searchV2?.tracksV2;
    if(!Array.isArray(page?.items))throw Error('SEARCH_SCHEMA_INVALID');
    const items=page.items.map(searchTrack).filter(Boolean),nextOffset=page.pagingInfo?.nextOffset;
    const total=Number.isSafeInteger(page.totalCount)?page.totalCount:undefined;
    const advances=Number.isSafeInteger(nextOffset)&&nextOffset>offset;
    return {items,total,consumed:advances?nextOffset-offset:page.items.length,next:advances?String(nextOffset):nextOffset===null?null:(page.items.length===limit&&(total===undefined||offset+limit<total)?String(offset+limit):null)};
  }
  async function setLiked(args){
    const uri='spotify:track:'+args.trackId,api=Spicetify.Platform.LibraryAPI;
    if(!trackId(uri)||typeof args.liked!=='boolean')throw Error('INVALID_TRACK');
    if(libraryRateLimited)throw Error('LIBRARY_RATE_LIMITED');
    if(typeof api?.contains!=='function'||typeof api?.[args.liked?'add':'remove']!=='function')throw Error('LIBRARY_WRITE_UNAVAILABLE');
    try{
      const before=await api.contains(uri);
      if(!Array.isArray(before)||typeof before[0]!=='boolean')throw Error('LIBRARY_SCHEMA_INVALID');
      if(before[0]!==args.liked)await api[args.liked?'add':'remove']({uris:[uri]});
      // A fulfilled write alone is not success: read the native library state back.
      for(let attempt=0;attempt<4;attempt++){
        if(attempt)await wait(250*attempt);
        const state=await api.contains(uri);
        if(Array.isArray(state)&&state[0]===args.liked)return {trackId:args.trackId,liked:args.liked,confirmed:true};
      }
      throw Error('LIBRARY_WRITE_UNCONFIRMED');
    }catch(e){
      if(Number(e?.status??e?.statusCode)===429)libraryRateLimited=true;
      if(libraryRateLimited)throw Error('LIBRARY_RATE_LIMITED');
      if(/^LIBRARY_/.test(e.message||''))throw e;
      throw Error('LIBRARY_WRITE_FAILED');
    }
  }
  // Spicetify 2.45.3 installs this getter during its broader UI-module discovery.
  // Spotify 1.3.4 can expose Platform first; bind the same read-only getter without replacing Wrapper commands.
  function wrapperPlayer(){
    const player=Spicetify.Player;
    if(player&&Spicetify.Platform?.PlayerAPI&&!Object.getOwnPropertyDescriptor(player,'origin'))
      Object.defineProperty(player,'origin',{configurable:true,enumerable:true,get:()=>Spicetify.Platform?.PlayerAPI});
    return player;
  }
  // Use the installed client's own color-lyrics contract. Never retry a 429 in this session.
  async function nativeLyrics(args){
    if(!/^[A-Za-z0-9]{22}$/.test(args.trackId||''))throw Error('INVALID_TRACK');
    if(lyricsCache.has(args.trackId))return {...await lyricsCache.get(args.trackId),cacheHit:true};
    if(lyricsRateLimited)throw Error('LYRICS_RATE_LIMITED');
    const pending=(async()=>{
      try{
        const image=typeof args.imageUrl==='string'?args.imageUrl:'';
        const body=await Spicetify.CosmosAsync.get('https://spclient.wg.spotify.com/color-lyrics/v2/track/'
          +encodeURIComponent(args.trackId)+'/image/'+encodeURIComponent(image)+'?format=json&vocalRemoval=false');
        const lyrics=body?.lyrics;
        const validObject=lyrics!==null&&typeof lyrics==='object';
        const validLines=Array.isArray(lyrics?.lines);
        const lines=validLines?lyrics.lines.filter(line=>line&&typeof line.words==='string'&&line.words.trim()).map(line=>({
          startTimeMs:line.startTimeMs,endTimeMs:line.endTimeMs,words:line.words})):[];
        const reason=lines.length?'received':!validObject?'missing-lyrics':!validLines?'invalid-lines':lyrics.lines.length?'blank-lines':'empty-lines';
        return {trackId:args.trackId,source:'spotify-native',syncType:lyrics?.syncType||'UNSYNCED',
          provider:lyrics?.provider||null,lines,reason,cacheHit:false,
          responseShape:{hasLyrics:validObject,hasLines:validLines,rawLineCount:validLines?lyrics.lines.length:null}};
      }catch(error){
        const status=Number(error?.status??error?.statusCode??error?.response?.status??error?.error?.status);
        if(status===429){lyricsRateLimited=true;throw Error('LYRICS_RATE_LIMITED');}
        if(status===404)return {trackId:args.trackId,source:'spotify-native',syncType:'UNSYNCED',lines:[],reason:'http-not-found',httpStatus:404,cacheHit:false};
        if(status===401)throw Error('LYRICS_AUTH_REQUIRED');
        if(status===403)throw Error('LYRICS_ACCESS_DENIED');
        throw Error('LYRICS_UNAVAILABLE');
      }
    })();
    lyricsCache.set(args.trackId,pending);
    // Only positive results survive completion. Empty/404/malformed results must not poison later playback.
    const evict=()=>{if(lyricsCache.get(args.trackId)===pending)lyricsCache.delete(args.trackId);};
    void pending.then(result=>{if(!result.lines.length)evict();},evict);
    return pending;
  }
  async function snapshot(){
    const snapshotStarted=performance.now();
    const p=Spicetify.Platform, user=await p.UserAPI.getUser(), raw=p.PlayerAPI._state;
    const userDone=performance.now();
    const d=p.ConnectAPI.getState()?.activeDevice;
    if(!user?.username||d?.isLocal!==true||!d.connectStateId)throw Error('DEVICE_INACTIVE');
    // Spotify publishes an empty zero-timestamp state while a selected track loads.
    // It has no usable clock; do not turn it into a position since Unix epoch.
    const stateReady=!!raw.item?.uri && Number.isFinite(raw.timestamp) && raw.timestamp>0
      && Number.isFinite(raw.positionAsOfTimestamp) && raw.duration>0;
    const wrapper=wrapperPlayer(),wrapperReady=wrapper?.origin===p.PlayerAPI
      && ['playUri','pause','play','seek'].every(name=>typeof wrapper?.[name]==='function');
    return {account:user.username,displayName:user.displayName||user.username,
      images:Array.isArray(user.images)?user.images.filter(image=>typeof image?.url==='string'&&image.url.startsWith('https://')).map(({url,width,height})=>({url,width,height})):[],
      deviceId:d.connectStateId,local:true,isActive:d.isActive===true,wrapperReady,
      restricted:d.isDisabled===true,uri:raw.item?.uri||null,durationMs:raw.duration,
      positionMs:stateReady?Math.max(0,Math.round(raw.positionAsOfTimestamp+(raw.isPaused?0:Date.now()-raw.timestamp))):null,
      stateReady,isPlaying:stateReady&&raw.isPaused===false,sampledAt:Date.now(),sourceTimestamp:stateReady?raw.timestamp:null,
      timing:{userMs:userDone-snapshotStarted,snapshotMs:performance.now()-snapshotStarted}};
  }
  async function handle(op,args, active=()=>true){
    if(op==='hello')return {protocol:1,version:'1.1.2',capabilities:['snapshot','command','catalog','lyrics','likedTracks','searchTracks','setLiked','independentReads','accountProfile']};
    if(op==='snapshot')return snapshot();
    if(op==='lyrics')return nativeLyrics(args);
    if(op==='searchTracks')return searchTracks(args);
    if(op==='setLiked'){
      const task=libraryWrites.then(()=>setLiked(args));libraryWrites=task.catch(()=>{});return task;
    }
    if(op==='likedTracks'){
      if(libraryRateLimited)throw Error('LIBRARY_RATE_LIMITED');
      if(typeof Spicetify.Platform.LibraryAPI?.getTracks!=='function')throw Error('LIBRARY_UNAVAILABLE');
      let result;
      try{result=await Spicetify.Platform.LibraryAPI.getTracks({offset:args.offset||0,limit:Math.min(50,args.limit||50)});}
      catch(error){if(error?.status===429||error?.code===429||String(error?.message).includes('429'))libraryRateLimited=true;throw Error(libraryRateLimited?'LIBRARY_RATE_LIMITED':'LIBRARY_UNAVAILABLE');}
      if(!Array.isArray(result?.items)||!Number.isSafeInteger(result.totalLength))throw Error('LIBRARY_SCHEMA_INVALID');
      const items=result.items.filter(t=>/^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri||'')).map(t=>({
        id:t.uri.slice(14),name:t.name,durationMs:t.duration?.milliseconds,
        artist:(t.artists?.items||t.artists||[]).map(a=>a.name).join(' / '),album:t.album?.name||'',
        coverUrl:(t.album?.images?.items||t.album?.images||[]).flat().map(i=>i.url)
          .map(url=>typeof url==='string'&&/^spotify:image:[a-f0-9]{40}$/.test(url)?'https://i.scdn.co/image/'+url.slice(14):url)
          .find(url=>typeof url==='string'&&url.startsWith('https://'))
      }));
      // Installed LibraryAPI filters metadata-less rows but exposes their consumed range in limit.
      // A zero unrangedLength can mean "not supplied", even when this page contains songs.
      const consumed=Number.isSafeInteger(result.limit)&&result.limit>=result.items.length?result.limit:result.items.length;
      const end=(args.offset||0)+consumed, knownTotal=result.totalLength>0?result.totalLength:undefined;
      const more=knownTotal!==undefined?end<knownTotal:consumed===Math.min(50,args.limit||50);
      return {items,total:knownTotal,consumed,next:more?'local-next':null};
    }
    if(op==='catalog') {
      const state=await snapshot(), raw=Spicetify.Platform.PlayerAPI._state, tracks=new Map(), seen=new Set();
      // Project only track metadata already loaded by Spotify; no catalog network request.
      function visit(value,depth=0) {
        if(!value||typeof value!=='object'||depth>5||seen.has(value)||seen.size>1500)return;
        seen.add(value);
        const m=value.metadata||{}, uri=value.uri;
        if(/^spotify:track:[A-Za-z0-9]{22}$/.test(uri||'')) {
          const duration=uri===state.uri?state.durationMs:Number(m.duration||m.duration_ms||value.duration);
          const name=m.title||m.name||value.name;
          const artwork=m.image_xlarge_url||m.image_large_url||m.image_url||m.image_small_url;
          const coverUrl=typeof artwork==='string'&&artwork.startsWith('https://')?artwork:
            typeof artwork==='string'&&/^spotify:image:[a-f0-9]{40}$/.test(artwork)?'https://i.scdn.co/image/'+artwork.slice(14):undefined;
          if(typeof name==='string'&&Number.isSafeInteger(duration)&&duration>0)
            tracks.set(uri.slice(14),{id:uri.slice(14),name,durationMs:duration,artist:m.artist_name||'',album:m.album_title||'',coverUrl});
        }
        for(const child of Object.values(value))if(child&&typeof child==='object')visit(child,depth+1);
      }
      visit(raw.item);visit(Spicetify.Queue);
      const next=Spicetify.Queue?.nextTracks?.[0];
      return {tracks:[...tracks.values()],queueKeys:Object.keys(Spicetify.Queue||{}).slice(0,15),queueShape:next?{keys:Object.keys(next),metadataKeys:Object.keys(next.metadata||{}),contextKeys:Object.keys(next.contextTrack||{}),contextMetadataKeys:Object.keys(next.contextTrack?.metadata||{})}:null};
    }
    if(op!=='command')throw Error('SOURCE_OPERATION_UNSUPPORTED');
    const before=await snapshot();
    if(before.account!==args.account||before.deviceId!==args.deviceId)throw Error('SESSION_CHANGED');
    const api=args.path==='origin'?Spicetify.Platform.PlayerAPI:wrapperPlayer();
    const invoke=async(kind,value)=>{
      if(!active())throw Error('BRIDGE_COMMAND_TIMEOUT');
      if(kind==='pause')await api.pause();
      else if(kind==='play')await (args.path==='origin'?api.resume():api.play());
      else if(kind==='seek')await (args.path==='origin'?api.seekTo(value):api.seek(value));
      else if(kind==='select')await (args.path==='origin'?api.play({uri:value},{},{}):api.playUri(value,{},{}));
      else throw Error('SOURCE_OPERATION_UNSUPPORTED');
    };
    const opName=args.operation;
    if(opName==='transfer'){if(!before.local)throw Error('DEVICE_INACTIVE');return {call:'no-transfer-needed',state:before};}
    if(opName==='play-at-position'){
      await invoke('seek',args.positionMs);
      const until=performance.now()+4000;let matched=false;
      do{if(!active())throw Error('BRIDGE_COMMAND_TIMEOUT');const s=await snapshot();if(Math.abs(s.positionMs-args.positionMs)<500){matched=true;break;}await wait(20);}while(performance.now()<until);
      if(!matched)throw Error('SEEK_UNCONFIRMED');
      await invoke('play');
    }else await invoke(opName,opName==='select'?'spotify:track:'+args.trackId:args.positionMs);
    return {call:'invocation-returned',state:await snapshot()};
  }
  function connect(){
  const ws=new WebSocket(bridgeUrl);currentSocket=ws;let queue=Promise.resolve();
  const connected=()=>currentSocket===ws&&ws.readyState===1;
  const reply=value=>{if(connected())ws.send(JSON.stringify(value));};
  ws.onopen=()=>{reconnectDelay=250;panel.textContent='Folia 实播桥接已连接（本机，无官方查询）';};
  ws.onclose=()=>{if(currentSocket!==ws)return;panel.textContent='Folia 实播桥接等待 Folia';
    const delay=reconnectDelay;reconnectDelay=Math.min(5000,reconnectDelay*2);setTimeout(connect,delay);};
  ws.onmessage=e=>{const deadline=performance.now()+8000;let request;try{request=JSON.parse(e.data);}catch{return;}
    const run=async()=>{if(!connected())return;let timer,expired=false;try{
      if(request.op==='command'&&performance.now()>=deadline)throw Error('BRIDGE_COMMAND_TIMEOUT');
      const operation=handle(request.op,request.args,()=>!expired&&connected());
      const value=request.op==='command'?await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('BRIDGE_COMMAND_TIMEOUT'));},Math.max(1,deadline-performance.now()));})]):await operation;
      reply({id:request.id,ok:true,value});}
      catch(error){reply({id:request.id,ok:false,code:/^[A-Z_]+$/.test(error.message)?error.message:'CONTROL_REJECTED',diagnostic:{
        operation:request.args?.operation,path:request.args?.path,errorName:error.name,
        message:String(error.message).replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'[token]').slice(0,240),
        wrapperOriginPresent:!!Spicetify.Player?.origin,wrapperPlayUriType:typeof Spicetify.Player?.playUri}});}
      finally{expired=true;if(timer)clearTimeout(timer);}};
    // Metadata network latency must never serialize pause, source preparation or seek.
    if(request.op!=='command')void run();else queue=queue.catch(()=>{}).then(run);
  };
  }
  connect();
})();
