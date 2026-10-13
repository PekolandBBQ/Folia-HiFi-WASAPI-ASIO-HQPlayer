'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const application = path.resolve(process.env.FOLIA_CANDIDATE_ROOT || path.join(__dirname, '../../..'));
const schema = require(path.join(application, 'electron/debug/privatePreviewDiagnosticSchema.cjs'));
// Baseline comparison is optional; candidate validation never requires a recovery tree.
const original = process.env.FOLIA_R22_BASELINE_ROOT
  ? require(path.join(path.resolve(process.env.FOLIA_R22_BASELINE_ROOT), 'electron/debug/privatePreviewDiagnosticSchema.cjs')) : null;
function fixture(enabled=true) {
  const rows = [], module={exports:{}};
  const dependencies={
    '../debug/privatePreviewDiagnosticSchema.cjs':schema,
    '../debug/privatePreviewDiagnosticBus.cjs':{
      isPreviewDiagnosticsEnabled:()=>enabled, previewSessionRef:()=>7,
      publishPreviewDiagnostic:(type,fields)=>{const row=schema.projectEvent(type,fields);if(row)rows.push(row);},
    },
    './playlistDiagnostics.cjs':{playlistResponseFields:()=>({})},
  };
  vm.runInNewContext(fs.readFileSync(path.join(application,'electron/spotify/requestDiagnostics.cjs'),'utf8'),
    {module,require:name=>{assert(Object.hasOwn(dependencies,name));return dependencies[name];}});
  return {...module.exports,rows};
}
test('two completed mute samples preserve count, empty-player facts and volume relation, without pause or silence claims',()=>{
  const f=fixture();
  f.reportSpotifyColdBootstrap('private-session','mute','observed',{observationCount:1,observedEmpty:true,volumeMatched:false});
  f.reportSpotifyColdBootstrap('private-session','mute','observed',{observationCount:2,observedEmpty:true,volumeMatched:true});
  assert.deepEqual(f.rows.map(r=>r.fields),[
    {sessionRef:7,stage:'mute',phase:'observed',observationCount:1,observedEmpty:true,volumeMatched:false},
    {sessionRef:7,stage:'mute',phase:'observed',observationCount:2,observedEmpty:true,volumeMatched:true},
  ]);
  if (original) {
    const before=original.projectEvent('spotify.cold-bootstrap',{sessionRef:7,stage:'mute',phase:'observed',observationCount:2});
    assert.equal(Object.hasOwn(before.fields,'observationCount'),false);
  }
});
test('deadline and cleanup failures retain existing closed codes and final completed observation count',()=>{
  const f=fixture();const timeout={code:'CONTROL_TIMEOUT'};
  f.reportSpotifyColdBootstrap('private-session','mute','failed',{observationCount:2,errorCode:timeout,selectInvoked:false,receiptRetained:true});
  f.reportSpotifyColdBootstrap('private-session','cleanup','failed',{errorCode:{code:'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED'},causeCode:timeout});
  assert.equal(f.rows[0].fields.errorCode,'CONTROL_TIMEOUT');assert.equal(f.rows[0].fields.observationCount,2);
  assert.equal(f.rows[1].fields.causeCode,'CONTROL_TIMEOUT');
});
test('count accepts only bounded nonnegative safe integers',()=>{
  for(const count of [0,1,2,10001])assert.equal(schema.projectEvent('spotify.cold-bootstrap',{sessionRef:1,stage:'mute',phase:'observed',observationCount:count}).fields.observationCount,count);
  for(const count of [-1,1.5,10002,NaN,Infinity,'2',null,{},[],Number.MAX_SAFE_INTEGER])assert.equal(Object.hasOwn(schema.projectEvent('spotify.cold-bootstrap',{sessionRef:1,stage:'mute',phase:'observed',observationCount:count}).fields,'observationCount'),false);
});
test('never reads getters, serializes raw data or exports device/track/volume/credential fields',()=>{
  const f=fixture();let reads=0;
  const facts={errorCode:{code:'CONTROL_TIMEOUT',message:'private-message'},causeCode:{code:'UNKNOWN'},volumeMatched:true,observedEmpty:true,
    originalVolume:42,volumePercent:0,deviceId:'private-device',trackId:'private-track',body:'private-body',headers:'private-headers',token:'private-token',url:'private-url',raw:'private-raw'};
  Object.defineProperty(facts,'observationCount',{get(){reads++;throw new Error('private-getter');}});
  f.reportSpotifyColdBootstrap('private-session','mute','failed',facts);
  assert.equal(reads,0);assert.equal(Object.hasOwn(f.rows[0].fields,'observationCount'),false);
  assert.doesNotMatch(JSON.stringify(f.rows),/private-|originalVolume|volumePercent|deviceId|trackId|body|headers|token|url|raw/);
});
test('UNKNOWN remains unknown; inherited codes and name/message getters are not read',()=>{
 let reads=0;const failure=Object.create({code:'CONTROL_TIMEOUT'});
 for(const name of ['name','message','code'])Object.defineProperty(failure,name,{get(){reads++;throw new Error('private-getter');}});
 assert.equal(schema.sourceErrorCode(failure),'UNKNOWN');assert.equal(reads,0);
 assert.equal(schema.sourceErrorCode({code:'PRIVATE_UNRECOGNIZED_ERROR'}),'UNKNOWN');
 assert.equal(schema.sourceErrorCode({code:23}),'UNKNOWN');
});
test('events stay main-only, required stages remain closed, diagnostics disabled leaves no events',()=>{
 assert.equal(schema.RENDERER_EVENTS.includes('spotify.cold-bootstrap'),false);
 const f=fixture();f.reportSpotifyColdBootstrap('private-session','private-stage','observed',{observationCount:2});assert.equal(f.rows.length,0);
 const off=fixture(false);off.reportSpotifyColdBootstrap('private-session','mute','observed',{observationCount:2});assert.equal(off.rows.length,0);
});
test('export re-projection retains only projected count and immutable safe values',()=>{
 const event=schema.projectEvent('spotify.cold-bootstrap',{sessionRef:3,stage:'mute',phase:'observed',observationCount:2,observedEmpty:true,volumeMatched:false});
 const record={timestamp:'2026-10-09T10:26:54.156Z',sequence:1,runId:'166faa11-4e5f-4c75-a422-3a94f7d3bc46',buildRef:'a'.repeat(64),...event};
 assert.deepEqual(schema.projectRecord(record),record);
 assert.deepEqual(schema.projectRecord(schema.projectRecord(record)),record);
 assert(Object.isFrozen(event.fields));
});
