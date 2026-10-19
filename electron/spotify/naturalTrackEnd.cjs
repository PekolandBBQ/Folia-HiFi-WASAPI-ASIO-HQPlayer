'use strict';
// A recent playing clock at the end distinguishes normal advance from an unrelated desktop selection.
function isNaturalTrackEnd(previous,next){
 if(!previous?.isPlaying||!next||!Number.isFinite(previous.observedAt)||!Number.isFinite(next.observedAt))return false;
 const elapsed=next.observedAt-previous.observedAt;
 return elapsed>=0&&elapsed<=8000&&previous.durationMs>0&&previous.positionMs>=previous.durationMs-5000
  &&previous.positionMs+elapsed>=previous.durationMs-500&&next.positionMs>=0&&next.positionMs<5000;
}
function isExternalSeek(previous,next){
 if(!previous||!next?.isPlaying||previous.trackId!==next.trackId)return false;
 const elapsed=next.observedAt-previous.observedAt;
 if(!Number.isFinite(elapsed)||elapsed<0||elapsed>8000)return false;
 const expected=previous.positionMs+(previous.isPlaying?elapsed:0);
 return Number.isFinite(expected)&&Number.isFinite(next.positionMs)&&Math.abs(next.positionMs-expected)>1000;
}
module.exports={isNaturalTrackEnd,isExternalSeek};
