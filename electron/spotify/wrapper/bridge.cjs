'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
// A profile-local address lets the existing desktop reconnect after Folia exits.
// Requests still belong to one connection and are never replayed after disconnect.
function profileSecret(file) {
  if (!file) return crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), {flag:'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const value = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('LOCAL_BRIDGE_CONFIG_INVALID');
  return value;
}
function createBridge(log, options={}) {
  const secret = profileSecret(options.secretPath), pending = new Map();
  let socket, serial=0, closed=false, rejection;
  const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  const wss=new WebSocketServer({noServer:true,maxPayload:65536});
  server.on('upgrade',(req,s,head)=>{
    const reason=socket?'connection-present':req.headers.origin!=='https://xpui.app.spotify.com'?'origin-mismatch':req.url!=='/bridge/'+secret?'connection-key-mismatch':null;
    if(reason){
      if(rejection?.reason!==reason)log('bridge-upgrade-rejected',{reason,socketState:socket?.readyState});
      rejection={reason,at:Date.now()};s.destroy();return;
    }
    wss.handleUpgrade(req,s,head,ws=>{
      socket=ws;rejection=undefined;log('bridge-connected',{});
      ws.on('message',data=>{
        let value;try{value=JSON.parse(data.toString());}catch{return ws.close();}
        const job=pending.get(value.id);if(!job)return;
        pending.delete(value.id);clearTimeout(job.timer);
        if(!value.ok)log('bridge-request-failed',{operation:job.op,code:value.code,elapsedMs:Date.now()-job.started});
        const code=value.code==='SOURCE_OPERATION_UNSUPPORTED'&&['searchTracks','setLiked'].includes(job.op)
          ? 'BRIDGE_UPDATE_REQUIRED' : value.code;
        value.ok?job.resolve(value.value):job.reject(Object.assign(Error(code),{code,diagnostic:value.diagnostic}));
      });
      ws.on('close',()=>{if(socket!==ws)return;socket=null;rejectPending();log('bridge-disconnected',{});});
    });
  });
  function rejectPending(){for(const job of pending.values()){clearTimeout(job.timer);job.reject(Object.assign(Error('SPOTIFY_INSTANCE_CHANGED'),{code:'SPOTIFY_INSTANCE_CHANGED'}));}pending.clear();}
  return {
    connected:()=>!closed&&socket?.readyState===1,
    connectionFailure:()=>rejection?{...rejection}:undefined,
    clearConnectionFailure:()=>{rejection=undefined;},
    async start(){await new Promise((yes,no)=>{server.once('error',no);server.listen(options.port??19238,'127.0.0.1',yes);});return {url:'ws://127.0.0.1:'+server.address().port+'/bridge/'+secret};},
    request(op,args={}) { if(closed||!socket||socket.readyState!==1)return Promise.reject(Object.assign(Error('SPOTIFY_INSTANCE_CHANGED'),{code:'SPOTIFY_INSTANCE_CHANGED'}));
      const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);log('bridge-request-failed',{operation:op,code:'CONTROL_TIMEOUT'});reject(Object.assign(Error('CONTROL_TIMEOUT'),{code:'CONTROL_TIMEOUT'}));},op==='hello'?3000:['lyrics','searchTracks','setLiked','likedTracks'].includes(op)?30000:10000);pending.set(id,{resolve,reject,timer,op,started:Date.now()});socket.send(JSON.stringify({id,op,args}));});},
    close(){closed=true;rejectPending();socket?.close();wss.close();server.close();},
  };
}
module.exports={createBridge};
