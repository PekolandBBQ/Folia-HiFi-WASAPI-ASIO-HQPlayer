'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const repository='PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer';
const releasesUrl=`https://github.com/${repository}/releases`;
const {sources,releaseUrl,asset,loadRelease}=require('./forkUpdateSources.cjs');
const manifestName='folia-hifi-update.json';
// Fork update discovery never consults upstream feeds or installs during a check/download.
function version(tag){const m=/^folia-hifi-v(\d+)\.(\d+)\.(\d+)-r(\d+)$/.exec(tag||'');return m?m.slice(1).map(Number):null;}
function compare(a,b){const x=version(a),y=version(b);if(!x||!y)throw Error('发布版本格式无法识别。');for(let i=0;i<x.length;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
function selectUpdate(release,manifest,current,installed,source='github'){
 if(release.draft||release.prerelease||!version(release.tag_name))throw Error('未找到专版正式发布。');
 const newer=compare(release.tag_name,current.forkTag);
 if(manifest&&(manifest.schema!==1||manifest.tag!==release.tag_name||!/^\d{13}$/.test(manifest.build)))throw Error('发布构建清单不完整，请稍后重试。');
 const sameBuild=newer===0&&manifest&&Number(manifest.build)>Number(current.build||0);
 const available=newer>0||sameBuild;
 const fallback=`Folia-HiFi-WASAPI-ASIO-HQPlayer-${version(release.tag_name).slice(0,3).join('.')}-win-x64${installed?'-Setup.exe':'.zip'}`;
 const kind=installed?'installer':'portable',name=manifest?.[kind]||fallback;
 let selected=asset(release,name,source);
 if(!selected&&manifest?.parts?.[kind]){
  const pieces=manifest.parts[kind];
  if(!Array.isArray(pieces)||!pieces.length)throw Error('更新分片清单为空。');
  const parts=pieces.map(p=>{const a=asset(release,p.name,source);if(!a||!Number.isSafeInteger(p.size)||p.size<=0||a.size!==p.size)throw Error(`更新源缺少完整分片：${p.name}。请等待同步完成。`);return {name:p.name,size:p.size,url:a.browser_download_url};});
  if(new Set(parts.map(p=>p.name)).size!==parts.length)throw Error('更新分片清单存在重复文件。');
  selected={name,size:parts.reduce((n,p)=>n+p.size,0),browser_download_url:parts[0].url,parts};
 }
 if(available&&!selected)throw Error('正式发布尚未提供对应的下载包。');
 return {status:available?'available':'latest',availableVersion:available?`${release.tag_name}${manifest?' · 构建 '+manifest.build:''}`:null,
 updateSource:source,tag:release.tag_name,updateUrl:`${releaseUrl(source)}/tag/${release.tag_name}`,downloadUrl:available?selected.browser_download_url:null,
 releaseNotes:available?(release.body||''):null,availableBuild:manifest?.build||null,
 downloadAsset:available?{name:selected.name,size:selected.size,url:selected.browser_download_url,...(selected.parts?{parts:selected.parts}:{})}:null};
}
function createForkUpdates({current,installed,fetcher,directory,publish,openExternal,openDownloaded=()=>{},install,timeoutMs=10000,getSource=()=> 'auto'}){
 let pending,downloading,downloaded=null,selection=null;
 const request=async(url,signal)=>{const response=await fetcher(url,{signal,headers:{Accept:'application/json','User-Agent':'Folia-HiFi'}});if(!response.ok)throw Error(response.status===404?'更新源尚未发布所需文件，请等待同步。':response.status===429||response.status===403?'更新源暂时限制访问，请稍后再试。':`更新服务请求失败（HTTP ${response.status}）。`);return response;};
 async function downloadRequest(url,signal){
  const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);if(signal.aborted)abort();
  try{return await request(url,controller.signal);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
 }
 async function discover(source){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await loadRelease(source,request,controller.signal);
   const ma=asset(r,manifestName,source),manifest=ma?await(await request(ma.browser_download_url+'?check='+Date.now(),controller.signal)).json():null;
   if(source==='gitee'&&!ma)throw Error('Gitee 尚未同步更新构建清单。');
   return selectUpdate(r,manifest,current,installed,source);
  }finally{clearTimeout(timer);}
 }
 const reason=e=>e.name==='AbortError'?'连接超时':/fetch failed|Failed to fetch/i.test(e.message)?'网络连接失败':e.message;
 return {
 async waitForCheck(){await pending;},
 check({manual=false}={}){
  if(downloading)return downloading;if(pending)return pending;
  pending=(async()=>{if(manual){selection=null;publish({status:'checking',error:null,availableVersion:null,downloadUrl:null,releaseNotes:null});}
   const chosen=getSource(),order=chosen==='auto'?['github','gitee']:[chosen],failures=[];
   try{
    for(const source of order){try{
     const next=await discover(source);selection=next;
     if(downloaded?.identity===next.tag+'#'+next.availableBuild&&fs.existsSync(downloaded.file))next.status='downloaded';
     publish({...next,error:null,lastCheckedAt:Date.now(),downloadProgress:null});return;
    }catch(e){failures.push(sources[source].label+'：'+reason(e));}}
    publish({...(manual?{status:'error',error:failures.join('；')}:{ }),lastCheckedAt:Date.now()});
   }finally{pending=null;}
  })();return pending;
 },
 download(){
  if(downloading)return downloading;
  if(!selection?.downloadAsset)return Promise.resolve();
  if(!installed&&!selection.downloadAsset.parts)return openExternal(selection.downloadUrl);
  const selected=selection.downloadAsset;
  downloading=(async()=>{let partial;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30*60*1000);
   try{await fsp.mkdir(directory,{recursive:true});const folder=await fsp.mkdtemp(path.join(directory,'download-'));const file=path.join(folder,installed?'Folia-HiFi-Setup.exe':'Folia-HiFi-portable.zip');partial=file+'.partial';
    publish({status:'downloading',error:null,downloadProgress:{percent:0}});
    let response,active=selected;
    try{response=await downloadRequest((active.parts?.[0]||active).url,controller.signal);}catch(error){
     if(getSource()!=='auto'||!selection.availableBuild)throw error;
     const alternate=await discover(selection.updateSource==='github'?'gitee':'github');
     if(alternate.tag!==selection.tag||alternate.availableBuild!==selection.availableBuild||alternate.downloadAsset?.name!==selected.name||alternate.downloadAsset?.size!==selected.size)throw Error('备用源尚未同步同一构建，请稍后重试下载。');
     active=alternate.downloadAsset;response=await downloadRequest((active.parts?.[0]||active).url,controller.signal);publish({updateSource:alternate.updateSource});
    }
    let transferred=0,last=0;
    // Append each original byte range in manifest order; never run an incomplete merged package.
    const parts=active.parts||[active];
    for(let i=0;i<parts.length;i++){
     if(i)response=await downloadRequest(parts[i].url,controller.signal);
     let partBytes=0;const input=Readable.fromWeb(response.body);input.on('data',chunk=>{partBytes+=chunk.length;transferred+=chunk.length;if(Date.now()-last>250){last=Date.now();publish({status:'downloading',downloadProgress:{transferred,total:selected.size,percent:selected.size?Math.min(100,transferred/selected.size*100):0}});}});
     await pipeline(input,fs.createWriteStream(partial,{flags:i?'a':'wx'}),{signal:controller.signal});
     if(parts[i].size&&partBytes!==parts[i].size)throw Error(`下载文件不完整：${parts[i].name}。请重新下载。`);
    }
    if(!transferred||selected.size&&transferred!==selected.size)throw Error('安装包下载不完整，请重新下载。');
    await fsp.rename(partial,file);downloaded={file,url:selected.url,identity:selection.tag+'#'+selection.availableBuild};publish({status:'downloaded',error:null,downloadProgress:null});if(!installed)await openDownloaded(file);
   }catch(e){if(partial)await fsp.rm(partial,{force:true}).catch(()=>{});publish({status:'error',error:e.name==='AbortError'?'下载超时，请重新下载。':reason(e),downloadProgress:null});}
   finally{clearTimeout(timer);downloading=null;}
  })();return downloading;
 },
 async confirmInstall(){if(!installed||!downloaded||downloaded.identity!==selection?.tag+'#'+selection?.availableBuild||!fs.existsSync(downloaded.file))return false;return install(downloaded.file);}
 };
}
module.exports={repository,releasesUrl,manifestName,version,compare,selectUpdate,createForkUpdates};
