'use strict';
const sources={
 github:{label:'GitHub',repository:'PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer',origin:'https://github.com',api:'https://api.github.com/repos'},
 gitee:{label:'Gitee',repository:'pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer',origin:'https://gitee.com',api:'https://gitee.com/api/v5/repos'},
};
// Normalize Gitee's attachment endpoint into the same release model; never mix different builds.
function releaseUrl(source){const s=sources[source];return `${s.origin}/${s.repository}/releases`;}
function asset(release,name,source='github'){
 const a=release.assets?.find(a=>a.name===name);if(!a)return null;
 try{const u=new URL(a.browser_download_url),s=sources[source];
  if(u.origin!==s.origin)return null;
  if(source==='gitee'&&!u.pathname.startsWith(`/${s.repository}/`)&&!u.pathname.startsWith('/attachments/download/'))return null;
  if(source==='github'&&!u.pathname.startsWith(`/${s.repository}/releases/download/${release.tag_name}/`))return null;
  return a;
 }catch{return null;}
}
async function loadRelease(source,request,signal){
 const s=sources[source],base=`${s.api}/${s.repository}`;
 const r=await(await request(`${base}/releases/latest`,signal)).json();
 if(source==='gitee'){
  if(!Number.isSafeInteger(r.id))throw Error('Gitee 尚未提供可用的正式发行版。');
  r.assets=await(await request(`${base}/releases/${r.id}/attach_files`,signal)).json();
  if(!Array.isArray(r.assets))throw Error('Gitee 发行版附件暂不可用。');
 }
 return r;
}
module.exports={sources,releaseUrl,asset,loadRelease};
