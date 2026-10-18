'use strict';
const fs=require('node:fs'),path=require('node:path');
// Windows PowerShell may exit without executing when created with DETACHED_PROCESS.
// Wait for the script itself, rather than CreateProcess, before allowing Folia to quit.
async function launchUpdateWaiter({directory,installer,application,parentId,launch,timeoutMs=15000}){
 const run=fs.mkdtempSync(path.join(directory,'install-'));
 const helper=path.join(run,'install-update.ps1'),ready=path.join(run,'ready'),log=path.join(run,'install.log');
 fs.copyFileSync(path.join(__dirname,'installForkUpdate.ps1'),helper);
 const child=launch('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
  '-ParentId',String(parentId),'-Installer',installer,'-InstallDirectory',path.dirname(application),'-Application',application,
  '-ReadyFile',ready,'-LogFile',log],{windowsHide:true,detached:false,stdio:'ignore'});
 await new Promise((resolve,reject)=>{
  let settled=false;
  const finish=error=>{if(settled)return;settled=true;clearInterval(poll);clearTimeout(timeout);child.removeListener('error',onError);child.removeListener('exit',onExit);if(error){try{child.kill();}catch{}reject(error);}else resolve();};
  const onError=error=>finish(error),onExit=code=>finish(Error(`更新助手在准备完成前退出（退出值 ${code}）。日志：${log}`));
  const poll=setInterval(()=>{if(fs.existsSync(ready))finish();},50);
  const timeout=setTimeout(()=>finish(Error(`更新助手未能在 15 秒内准备完成。日志：${log}`)),timeoutMs);
  child.once('error',onError);child.once('exit',onExit);
 });
 child.unref();return {log};
}
module.exports={launchUpdateWaiter};
