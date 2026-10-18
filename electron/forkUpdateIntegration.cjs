'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync,execFile,spawn}=require('node:child_process');
const {createForkUpdates}=require('./forkUpdates.cjs');
// Require both the local uninstaller and its registered location; copied portable folders are not installations.
function isInstalled(directory,query=()=>execFileSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','/s','/v','UninstallString'],{encoding:'utf8',windowsHide:true,timeout:5000})){
 const uninstaller=path.join(directory,'Uninstall Folia-HiFi-WASAPI-ASIO-HQPlayer.exe');
 try{return fs.existsSync(uninstaller)&&query().toLowerCase().includes(uninstaller.toLowerCase());}catch{return false;}
}
function detectInstalled(directory){
 const uninstaller=path.join(directory,'Uninstall Folia-HiFi-WASAPI-ASIO-HQPlayer.exe');
 if(!fs.existsSync(uninstaller))return Promise.resolve(false);
 return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  String.raw`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Select-Object -ExpandProperty UninstallString -ErrorAction SilentlyContinue`],
  {encoding:'utf8',windowsHide:true,timeout:5000},(error,out)=>resolve(!error&&out.toLowerCase().includes(uninstaller.toLowerCase()))));
}
function create({app,session,dialog,current,publish,shell,installed,getSource=()=> 'auto',launch=spawn}){
 const directory=path.join(app.getPath('userData'),'updates');
 return createForkUpdates({current,installed,directory,publish,getSource,openExternal:url=>shell.openExternal(url),
 fetcher:(url,options)=>session.fromPartition('folia-fork-update').fetch(url,options),
 install:async installer=>{
  const answer=await dialog.showMessageBox({type:'question',title:'更新 Folia HiFi',message:'安装包已下载。现在退出 Folia 并更新吗？',detail:'更新会停止播放并完成退出清理。现有配置和组件备份保留，完成后重新打开 Folia。',buttons:['暂不更新','退出并更新'],defaultId:0,cancelId:0});
  if(answer.response!==1)return false;
  const helper=path.join(directory,'install-update.ps1');fs.writeFileSync(helper,fs.readFileSync(path.join(__dirname,'installForkUpdate.ps1')));
  try{
   const child=launch('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ParentId',String(process.pid),'-Installer',installer,'-InstallDirectory',path.dirname(process.execPath),'-Application',process.execPath],{windowsHide:true,detached:true,stdio:'ignore'});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();app.quit();return true;
  }catch{publish({status:'error',error:'无法启动更新程序，Folia 尚未退出。请重试或手动下载安装。'});return false;}
 }
 });
}
module.exports={isInstalled,detectInstalled,create};
