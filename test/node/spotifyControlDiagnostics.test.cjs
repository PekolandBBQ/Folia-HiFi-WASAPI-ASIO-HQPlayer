'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {errorFacts,stateFacts}=require('../../electron/spotify/controlDiagnostics.cjs');
const {publicError}=require('../../electron/spotify/cableAudioFacts.cjs');
const {failureDetails}=require('../../electron/spotify/failureDetails.cjs');
// Retain independent original/cleanup failures through the public playback boundary.
test('original and cleanup reasons survive projection and have Chinese output',()=>{
 const error=Object.assign(Error('hidden'),{code:'ROUTE_SOURCE_PAUSE_UNCONFIRMED',
  cause:{code:'TRACK_NOT_CURRENT'},cleanupError:{code:'CONTROL_REJECTED'},stage:'cleanup-route-pause'});
 const projected=publicError(error),details=failureDetails(projected,'audio');
 assert.equal(details.causeCode,'TRACK_NOT_CURRENT');assert.equal(details.cleanupCode,'CONTROL_REJECTED');
 assert.match(details.detail,/清理旧会话/);assert.ok(!details.detail.includes('CONTROL_REJECTED'));
 assert.equal(errorFacts(error).cleanupError.code,'CONTROL_REJECTED');
});
test('pause snapshots omit unrelated response data',()=>{
 assert.deepEqual(stateFacts({trackId:'a',isPlaying:true,positionMs:100,token:'secret',url:'private',disallows:{pausing:true}}),
  {trackId:'a',positionMs:100,isPlaying:true,pausingDisallowed:true});
});
