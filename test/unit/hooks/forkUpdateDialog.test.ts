// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import ForkUpdateDialog from '@/components/app/dialogs/ForkUpdateDialog';
vi.mock('@/stores/useThemeSettingsStore',()=>({useThemeSettingsStore:(select:any)=>select({isDaylight:false})}));
vi.mock('@/components/modal/settings/ForkAbout',()=>({formatForkVersion:(v:string)=>v}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

it('keeps cancellation enabled while download is pending and offers a working retry before installation',async()=>{
 const container=document.createElement('div'),root=createRoot(container);
 const base={forkUpdate:true,status:'available',availableVersion:'r9',availableBuild:'123',autoUpdateSupported:true,releaseNotes:'WAV 修复'} as ElectronUpdateStatus;
 let receive:(s:ElectronUpdateStatus)=>void=()=>{},finish:(s:ElectronUpdateStatus)=>void=()=>{},attempt=0;
 const download=vi.fn(()=>{attempt++;return attempt===1?new Promise<ElectronUpdateStatus>(resolve=>{finish=resolve;}):Promise.resolve({...base,status:'downloaded'} as ElectronUpdateStatus);});
 const cancelled={...base,downloadCancelled:true};
 const cancel=vi.fn(async()=>{receive(cancelled);finish(cancelled);return cancelled;}),install=vi.fn();
 Object.defineProperty(window,'electron',{configurable:true,value:{getUpdateStatus:async()=>base,onUpdateStatusChanged:(fn:any)=>{receive=fn;return()=>{};},downloadUpdate:download,cancelUpdateDownload:cancel,quitAndInstallUpdate:install}});
 const button=(name:string)=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent===name)!;
 try {
  await act(async()=>root.render(React.createElement(ForkUpdateDialog)));expect(container.textContent).toContain('WAV 修复');
  await act(async()=>{button('下载更新').click();receive({...base,status:'downloading'});});
  expect(button('取消下载').disabled).toBe(false);expect(install).not.toHaveBeenCalled();
  await act(async()=>button('取消下载').click());expect(cancel).toHaveBeenCalledOnce();expect(container.textContent).toContain('已取消下载');
  await act(async()=>button('重新下载').click());expect(download).toHaveBeenCalledTimes(2);expect(button('退出并更新')).toBeDefined();expect(install).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());}
});
