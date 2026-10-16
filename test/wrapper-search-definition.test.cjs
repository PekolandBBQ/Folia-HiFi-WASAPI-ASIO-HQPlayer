'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readSearchDefinition}=require('../electron/spotify/wrapper/searchDefinition.cjs');
// Extract each installation's own query identity and tolerate unavailable search chunks.
test('query identity follows installed resources rather than a pinned client version',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'folia-search-definition-'));
 try{
  assert.equal(readSearchDefinition(dir),null);fs.mkdirSync(path.join(dir,'xpui'));
  for(const char of ['a','b']){
   fs.writeFileSync(path.join(dir,'xpui/xpui-routes-search.js'),'Spicetify.GraphQL.Definitions["searchTracks"]=new I.l("searchTracks","query","'+char.repeat(64)+'",null);');
   assert.equal(readSearchDefinition(dir).sha256Hash,char.repeat(64));
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
