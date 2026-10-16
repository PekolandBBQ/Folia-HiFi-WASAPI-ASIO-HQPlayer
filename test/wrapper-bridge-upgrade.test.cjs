'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const {createBridge}=require('../electron/spotify/wrapper/bridge.cjs');
const {failureDetails}=require('../electron/spotify/failureDetails.cjs');
// An upgraded Folia can reconnect to a still-running older Spotify extension.
test('old extension reports a restart instruction for new metadata operations without changing control errors',async()=>{
 const bridge=createBridge(()=>{}, {port:0});const {url}=await bridge.start();
 const client=new WebSocket(url,{origin:'https://xpui.app.spotify.com'});
 try{
  await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
  client.on('message',data=>{const request=JSON.parse(data);client.send(JSON.stringify({id:request.id,ok:false,code:'SOURCE_OPERATION_UNSUPPORTED'}));});
  for(const op of ['searchTracks','setLiked'])await assert.rejects(bridge.request(op,{}),e=>{
   assert.equal(e.code,'BRIDGE_UPDATE_REQUIRED');assert.match(failureDetails(e,'search').detail,/保持 Folia 打开/);return true;
  });
  await assert.rejects(bridge.request('command',{}),{code:'SOURCE_OPERATION_UNSUPPORTED'});
 }finally{client.close();bridge.close();}
});
