'use strict';
// Fixed playback facts only: no account credentials, source URLs or response bodies.
function stateFacts(state){
 if(!state)return null;
 const result={};
 for(const key of ['trackId','deviceId','positionMs','durationMs','observedAt','serverTimestamp','isPlaying'])
  if(['string','number','boolean'].includes(typeof state[key]))result[key]=state[key];
 if(state.disallows)result.pausingDisallowed=state.disallows.pausing===true;
 return result;
}
function errorFacts(error,depth=0){
 if(!error||depth>3)return undefined;
 const result={};
 for(const key of ['code','stage','nativeCode','failureCode','stateMismatch','expectedPlaying','actualPlaying'])
  if(['string','number','boolean'].includes(typeof error[key]))result[key]=error[key];
 if(error.cause)result.cause=errorFacts(error.cause,depth+1);
 if(error.cleanupError)result.cleanupError=errorFacts(error.cleanupError,depth+1);
 return result;
}
module.exports={stateFacts,errorFacts};
