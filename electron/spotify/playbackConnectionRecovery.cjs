const { execFile } = require('node:child_process');
const { resolveOwnedRouteComponent } = require('./ownedRouteHost.cjs');

// electron/spotify/playbackConnectionRecovery.cjs — concrete recovery instead of replaying an unchanged failed request.
async function repairSpotifyOutput({ componentDirectory, current, log, execute = execFile, resolveComponent = resolveOwnedRouteComponent }) {
  current(); const executable = await resolveComponent(componentDirectory); current();
  const result = await new Promise((resolve,reject)=>execute(executable,['--repair-spotify-output'],
    {windowsHide:true,timeout:30000,maxBuffer:16384},(error,stdout)=>{
      let value;try{value=JSON.parse(stdout);}catch{}
      if(!error&&value?.repaired===true&&value.globalDefaultsWritten===false&&value.originalPoliciesRetained===true)return resolve(value);
      const code=/^[A-Z][A-Z0-9_]{1,127}$/.test(value?.code||'')?value.code:'SPOTIFY_OUTPUT_REPAIR_FAILED';
      reject(Object.assign(Error(code),{code,stage:'spotify-output-repair'}));
    }));
  current();log('spotify-output-repaired',result);return result;
}
async function prepareWithConnectionRecovery({ ensure, prepare, configure, repairOutput, current, log }) {
  try { await ensure();current();return await prepare(); }
  catch(error) {
    const code=error?.failureCode||error?.nativeCode||error?.code;
    const output=code==='ORIGINAL_ENDPOINT_UNSAFE';
    if(!output&&!['SPOTIFY_BRIDGE_NOT_READY','SPOTIFY_BRIDGE_TIMEOUT','SPOTIFY_PLAYER_NOT_READY',
      'BRIDGE_NOT_CONNECTED','BRIDGE_TIMEOUT','BRIDGE_UPDATE_REQUIRED','BRIDGE_RUNTIME_OUTDATED','BRIDGE_RUNTIME_UNMANAGED','BRIDGE_CAPABILITY_MISSING'].includes(code))throw error;
    current();log('spotify-playback-recovery',{phase:'begin',code,stage:error.stage,repair:output?'app-output-and-configuration':'configuration-and-handshake'});
    try {
      if(output)await repairOutput();
      current();await configure();current();await ensure();current();
      const result=await prepare();current();
      log('spotify-playback-recovery',{phase:'recovered',originalCode:code});return result;
    }catch(recoveryError){
      log('spotify-playback-recovery',{phase:'failed',originalCode:code,recoveryCode:recoveryError.code,stage:recoveryError.stage});
      recoveryError.originalFailure=error;throw recoveryError;
    }
  }
}
module.exports={repairSpotifyOutput,prepareWithConnectionRecovery};
