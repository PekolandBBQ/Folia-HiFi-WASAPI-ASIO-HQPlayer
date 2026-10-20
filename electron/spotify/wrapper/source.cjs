'use strict';
// Local Spicetify observations have local sampling times, not official GET timestamps or grants.
const fail=code=>Object.assign(Error(code),{code});
function createLocalSource(bridge,log,{now=Date.now}={}) {
  let account,device,path='origin',unknown=false;const stamp={epoch:1,revision:1}, tracks=new Map();
  async function sample(role='sample',expected){
    const readStartedAt=now();
    const value=await bridge.request('snapshot');
    if(value.local!==true||!value.account||!value.deviceId)throw fail('DEVICE_INACTIVE');
    if(account && (value.account!==account||value.deviceId!==device)){
      // Retire old command authority once, then allow the next explicit recovery
      // to authorize the newly loaded local client instead of failing forever.
      stamp.revision++;account=value.account;device=value.deviceId;throw fail('SESSION_CHANGED');
    }
    account=value.account;device=value.deviceId;
    if(/^spotify:track:[A-Za-z0-9]{22}$/.test(value.uri||'')&&Number.isSafeInteger(value.durationMs))tracks.set(value.uri.slice(14),{trackId:value.uri.slice(14),durationMs:value.durationMs});
    // A producer clock must not create a future host observation. The host
    // request start is a conservative freshness bound, never a refreshed ACK.
    const receivedAt=now();
    log('source-sample',{role,totalMs:receivedAt-readStartedAt,userMs:value.timing?.userMs,snapshotMs:value.timing?.snapshotMs,
      playing:value.isPlaying,active:value.isActive,trackMatched:expected?value.uri==='spotify:track:'+expected.trackId:undefined,
      positionMs:value.positionMs,sourceAgeMs:value.sourceTimestamp?receivedAt-value.sourceTimestamp:null});
    if(value.sampledAt>receivedAt)log('source-clock-ahead',{milliseconds:value.sampledAt-receivedAt});
    return {...value,producerSampledAt:value.sampledAt,sampledAt:readStartedAt};
  }
  function facts(body,expected,{matchTrack=true}={}){
    if(body.stateReady===false)throw fail('PLAYBACK_UNAVAILABLE');
    if(body.deviceId!==expected.deviceId)throw fail('DEVICE_ID_MISMATCH');
    if(!body.isActive)throw fail('DEVICE_INACTIVE');if(body.restricted)throw fail('DEVICE_RESTRICTED');
    const trackId=body.uri?.slice(14);
    if(matchTrack&&trackId!==expected.trackId)throw fail('TRACK_NOT_CURRENT');
    if(!Number.isSafeInteger(body.durationMs)||body.durationMs<1||body.durationMs>3600000)throw fail('METADATA_INVALID');
    // Restored Spotify state can carry rounded duration until the track loads.
    // This local adapter owns the controller record's observed media duration.
    if(trackId===expected.trackId)expected.durationMs=body.durationMs;
    return {deviceId:body.deviceId,trackId,positionMs:Math.min(body.durationMs,body.positionMs),durationMs:body.durationMs,
      isPlaying:body.isPlaying,observedAt:body.sampledAt,disallows:{pausing:false,resuming:false,seeking:false}};
  }
  return {stamp:()=>({...stamp}),setPath(value){if(!['origin','wrapper'].includes(value))throw fail('PROTOCOL_INVALID');path=value;},sample,
    async metadata(id){await sample();if(!tracks.has(id))throw fail('TRACK_NOT_CURRENT');return tracks.get(id);},
    describeState:body=>({deviceId:body.deviceId,trackId:body.uri?.slice(14),durationMs:body.durationMs}),playbackFacts:facts,
    async authorize(current){current();await sample();current();return {...stamp};},hasUnsettledWrites:()=>unknown,
    async request(operation,record,current,options={}){
      current();if(options.signal?.aborted)throw fail('CANCELLED');
      if(operation==='state')return sample('state',record);
      if(operation==='devices'){const s=await sample();return {devices:[{id:s.deviceId,name:'当前本机 Spotify',type:'computer',is_active:s.isActive,is_restricted:s.restricted}]};}
      if(unknown)throw fail('SOURCE_EFFECT_UNKNOWN');
      const before=await sample();current();
      if(record.deviceId!==before.deviceId)throw fail('DEVICE_ID_MISMATCH');
      if(options.matchTrackBeforeDispatch&&before.uri!=='spotify:track:'+record.trackId)throw fail('TRACK_NOT_CURRENT');
      if(options.beforeDispatch)await options.beforeDispatch();current();if(options.signal?.aborted)throw fail('CANCELLED');
      options.onDispatch?.();record.mutationPending=true;unknown=true;
      const start=Date.now();
      // Unknown/disconnected producers remain pending; return is never treated as observed effect.
      const reply=await bridge.request('command',{path,operation,account,deviceId:device,trackId:record.trackId,positionMs:options.positionMs});
      unknown=false;current();log('local-command',{path,operation,elapsedMs:Date.now()-start,call:reply.call});
      return {acknowledgment:'UNCONFIRMED'};
    },
  };
}
module.exports={createLocalSource};
