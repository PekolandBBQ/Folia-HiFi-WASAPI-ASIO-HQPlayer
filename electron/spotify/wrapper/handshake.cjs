'use strict';
const path = require('node:path');
// Runtime evidence is independent of files and current playback state.
const expected = {protocol:1,version:'1.1.0',capabilities:['snapshot','command','catalog','lyrics','likedTracks','searchTracks','setLiked']};
async function inspectHandshake(bridge){
 try{
  const value=await bridge.request('hello');
  const version=typeof value?.version==='string'&&/^\d+\.\d+\.\d+$/.test(value.version)?value.version:undefined;
  const missing=expected.capabilities.filter(cap=>!Array.isArray(value?.capabilities)||!value.capabilities.includes(cap));
  const ready=value?.protocol===expected.protocol&&Boolean(version)&&!missing.length;
  return {state:ready?'ready':'outdated',version,expectedVersion:expected.version,missing,
   detail:ready?`已加载桥接 ${version}，播放、在线搜索和收藏能力已确认`:`运行中的桥接${version?' '+version:''}与当前 Folia 不匹配。请退出 Spotify 后回到 Folia 重试，由 Folia 自动拉起。`};
 }catch(error){
  const legacy=['SOURCE_OPERATION_UNSUPPORTED','BRIDGE_UPDATE_REQUIRED'].includes(error.code);
  return {state:legacy?'outdated':'unconfirmed',expectedVersion:expected.version,detail:legacy?'运行中仍是旧桥接，未提供版本和能力握手。请退出 Spotify 后回到 Folia 重试，由 Folia 自动拉起。':'桥接版本和能力暂未确认，请稍后重新检查；无需重新安装。'};
 }
}
async function inspectRuntime(bridge,running,apps){
 if(bridge.connected())return inspectHandshake(bridge);
 if(!running.length)return {state:'stopped',detail:'Spotify 尚未启动'};
 const main=running.filter(p=>p.mainProcess===true);
 if(main.some(p=>p.commandLineKnown&&!p.appDirectory))return {state:'unmanaged',detail:'Spotify 未带 Folia 资源目录启动，未加载桥接。请退出 Spotify 后回到 Folia 重试，由 Folia 自动拉起。'};
 if(main.some(p=>p.appDirectory&&path.resolve(p.appDirectory).toLowerCase()!==path.resolve(apps).toLowerCase()))return {state:'wrong-assets',detail:'Spotify 使用了另一套资源目录。请退出 Spotify 后回到 Folia 重试，由 Folia 加载当前配置。'};
 return {state:'waiting',detail:'Spotify 已运行，尚未确认桥接加载；请稍后重新检查'};
}
async function requireHandshake(bridge){const state=await inspectHandshake(bridge);if(state.state!=='ready')throw Object.assign(Error(state.detail),{code:state.state==='outdated'?'BRIDGE_UPDATE_REQUIRED':'SPOTIFY_BRIDGE_NOT_READY'});}
module.exports={expected,inspectHandshake,inspectRuntime,requireHandshake};
