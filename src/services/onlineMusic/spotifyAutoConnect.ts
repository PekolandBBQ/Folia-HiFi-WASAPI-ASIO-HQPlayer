import { beginPlaybackLoad, updatePlaybackLoad, endPlaybackLoad, usePlaybackLoadStore } from '../../stores/usePlaybackLoadStore';
import { requestSpotify } from './spotifyTransport';
// Complete missing setup steps through the same resumable installer used by the manual guide.
type SetupStatus = {
 ready: boolean; connected: boolean; cli: boolean; wrapper: boolean; extension: boolean; engine: boolean;
 driver: boolean; driverCurrent?: boolean; driverEndpointsReady: boolean; selected?: string;
 installations: { id: string }[]; detectionFailed?: boolean; issues?: { detail?: string }[];
 install: { busy: boolean; phase: string; detail?: string; restartRequired?: boolean; code?: string };
};
type Request = (operation: 'status' | 'install' | 'configure' | 'launch') => Promise<SetupStatus>;
export function createSpotifyAutoConnect(request: Request, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
 return async () => {
  let status = await request('status');
  const failure = (detail: string) => ({ ready: false, detail });
  async function settle() {
   for (let poll = 0; status.install.busy && poll < 600; poll++) { await wait(1000); status = await request('status'); }
   if (status.install.busy) return failure('组件准备仍在进行，请稍后再打开歌单。');
   if (status.install.restartRequired) return failure('音频驱动安装完成，需要重启 Windows 后才能继续连接。');
   return null;
  }
  let blocked = await settle(); if (blocked) return blocked;
  if (!status.installations.length) return failure(status.detectionFailed ? '暂时无法检测 Spotify 安装位置。' : '尚未安装 Spotify，请自行安装并登录账号。');
  if (!status.selected) return failure('检测到多个 Spotify，请选择要连接的版本。');
  if (!status.cli || !status.engine || !status.driver || status.driverCurrent === false) {
   // Do not reopen an installer cancelled by the user in every silent retry.
   if (status.install.code === 'SPOTIFY_DRIVER_INSTALL_NOT_COMPLETED') return failure(status.install.detail || '音频驱动安装未完成，请完成安装后继续。');
   status = await request('install'); blocked = await settle(); if (blocked) return blocked;
   if (status.install.phase === 'failed') return failure(status.install.detail || '组件安装未完成，请在向导中查看具体原因。');
  }
  if (!status.wrapper || !status.extension || !status.driverEndpointsReady) {
   status = await request('configure'); blocked = await settle(); if (blocked) return blocked;
   if (status.install.phase === 'failed') return failure(status.install.detail || 'Spotify 自动配置未完成，请在向导中查看具体原因。');
  }
  if (!status.connected) {
   try { status = await request('launch'); }
   catch (error) {
    const failure = error as { code?: string; details?: { nativeCode?: string } };
    const code=failure.details?.nativeCode || failure.code;
    if(!['SPOTIFY_BRIDGE_NOT_READY','SPOTIFY_BRIDGE_TIMEOUT','SPOTIFY_PLAYER_NOT_READY','BRIDGE_UPDATE_REQUIRED','BRIDGE_TIMEOUT','SPOTIFY_RESOURCE_VERSION_CHANGED'].includes(code || ''))throw error;
    status = await request('configure'); blocked = await settle(); if(blocked)return blocked;
    if(status.install.phase==='failed')return failureResult(status.install.detail);
    status = await request('launch');
   }
  }
  return { ready: status.ready, detail: status.issues?.find(issue => issue.detail)?.detail || 'Spotify 尚未连接成功，请在向导中查看具体原因。' };
 function failureResult(detail?:string){return failure(detail || 'Spotify 自动配置未完成，具体失败步骤已记录。');}
 };
}
export const autoConnectSpotify = createSpotifyAutoConnect(async operation => {
 const owner = 'spotify-startup-' + crypto.randomUUID();
 let ready = false;
 try {
  return await requestSpotify<SetupStatus>({ action: 'desktopSetup', operation }, { onProgress: progress => {
   ready = progress.stage === 'spotifyReady';
   const current = usePlaybackLoadStore.getState().owner;
   // Background startup must not overwrite preparation for a song selected by the listener.
   if (!current || current === owner) {
    if (!current) beginPlaybackLoad(owner, progress.stage);
    updatePlaybackLoad(owner, progress);
   }
  } });
 } finally {
  if (ready) setTimeout(() => endPlaybackLoad(owner), 1200);
  else endPlaybackLoad(owner);
 }
});
