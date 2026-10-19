'use strict';
// A handoff belongs to the source that reported it, never to a later Folia selection.
function createExternalSelectionCoordinator({send,stopOutput,sample,continueSpotify,name,log}){
 let epoch=0,pending=null,settling=Promise.resolve();
 const emit=(entry,phase,extra={})=>send({phase,token:entry.token,trackId:entry.facts.trackId,
  previousTrackId:entry.facts.previousTrackId,positionMs:entry.facts.positionMs,name:name(entry.facts.trackId),...extra});
 function notify(facts,isCurrent=()=>true){
  if(!isCurrent())return;
  const previous=pending;
  if(previous)facts={...facts,previousTrackId:previous.facts.previousTrackId,naturalEnd:false,externalSeek:false};
  const entry={token:++epoch,facts,isCurrent};pending=entry;
  log('external-handoff',{token:entry.token,trackId:facts.trackId,previousTrackId:facts.previousTrackId,positionMs:facts.positionMs,naturalEnd:facts.naturalEnd===true,externalSeek:facts.externalSeek===true,externalPause:facts.externalPause===true,externalResume:facts.externalResume===true});
  // Present before any cleanup/metadata work can fail.
  emit(entry,'paused',{naturalEnd:facts.naturalEnd===true,externalSeek:facts.externalSeek===true,externalPause:facts.externalPause===true,externalResume:facts.externalResume===true});
  settling=settling.then(async()=>{
   if(pending!==entry||!isCurrent())return;
   const output=await stopOutput();await output?.complete?.();
   if(pending!==entry||!isCurrent())return;
   entry.ready=true;
   if(facts.naturalEnd){pending=null;emit(entry,'advance');}
   else if(facts.externalSeek||facts.externalResume){pending=null;emit(entry,'follow',{externalSeek:true,externalResume:facts.externalResume===true});}
   else if(facts.externalPause){pending=null;emit(entry,'dismiss');}
  }).catch(error=>{
   log('external-cleanup-failed',{code:error.code,message:error.message});
   if(pending===entry)emit(entry,'paused',{error:'停止旧输出尚未完成，请稍后再确认追随。'});
  });
  return settling;
 }
 async function decide(token,choice){
  const entry=pending;
  if(!entry||entry.token!==token)return {stale:true};
  log('external-handoff-choice',{token,choice,trackId:entry.facts.trackId});
  if(choice==='pause'){pending=null;emit(entry,'dismiss');return {ok:true};}
  if(!['follow','spotify'].includes(choice))throw Error('INVALID_HANDOFF_CHOICE');
  await settling;
  if(pending!==entry||!entry.isCurrent())return {stale:true};
  if(!entry.ready){const output=await stopOutput();await output?.complete?.();entry.ready=true;}
  if(pending!==entry||!entry.isCurrent())return {stale:true};
  const actual=await sample();
  if(pending!==entry||!entry.isCurrent())return {stale:true};
  const trackId=/^spotify:track:([A-Za-z0-9]{22})$/.exec(actual.uri||'')?.[1];
  if(!trackId)throw Error('Spotify 当前没有可追随的歌曲');
  if(trackId!==entry.facts.trackId){
   entry.facts={...entry.facts,trackId,positionMs:actual.positionMs};
   emit(entry,'paused',{error:'Spotify 又切换了歌曲，请确认是否追随当前歌曲。'});return {changed:true};
  }
  if(choice==='spotify')await continueSpotify(actual,()=>pending===entry);
  if(pending!==entry)return {stale:true};
  pending=null;emit(entry,choice==='follow'?'follow':'dismiss',{positionMs:actual.positionMs});
  return {ok:true};
 }
 return {notify,decide,cancel(){const entry=pending;pending=null;++epoch;if(entry)emit(entry,'dismiss');return settling;}};
}
module.exports={createExternalSelectionCoordinator};
