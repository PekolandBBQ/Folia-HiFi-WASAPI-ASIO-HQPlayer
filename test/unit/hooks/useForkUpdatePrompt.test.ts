// @vitest-environment jsdom
// Update discovery must never imply permission to download or install.
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {useForkUpdatePrompt} from '@/hooks/useForkUpdatePrompt';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root, current:ReturnType<typeof useForkUpdatePrompt>;
afterEach(()=>{act(()=>root?.unmount());});
it('shows release notes once per build and downloads and installs only on explicit choices',async()=>{
 const available={forkUpdate:true,status:'available',availableVersion:'r6',availableBuild:'123',releaseNotes:'修复续播',autoUpdateSupported:true} as ElectronUpdateStatus;
 let receive:(s:ElectronUpdateStatus)=>void=()=>{};
 const download=vi.fn(async()=>({...available,status:'downloaded'} as ElectronUpdateStatus)),install=vi.fn(async()=>{}),cancel=vi.fn(async()=>({...available,downloadCancelled:true}));
 Object.defineProperty(window,'electron',{configurable:true,value:{getUpdateStatus:async()=>available,onUpdateStatusChanged:(fn:any)=>{receive=fn;return ()=>{};},downloadUpdate:download,cancelUpdateDownload:cancel,quitAndInstallUpdate:install}});
 root=createRoot(document.createElement('div'));
 await act(async()=>{root.render(React.createElement(function Probe(){current=useForkUpdatePrompt();return null;}));});
 expect(current.open).toBe(true);expect(current.status?.releaseNotes).toBe('修复续播');expect(download).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
 await act(async()=>current.close());await act(async()=>receive(available));expect(current.open).toBe(false);expect(download).not.toHaveBeenCalled();
 await act(async()=>receive({...available,availableBuild:'124'}));expect(current.open).toBe(true);
 await act(async()=>receive({...available,status:'downloading'}));
 await act(async()=>current.cancelDownload());expect(cancel).toHaveBeenCalledOnce();expect(current.status?.downloadCancelled).toBe(true);expect(install).not.toHaveBeenCalled();
 await act(async()=>current.download());expect(download).toHaveBeenCalledTimes(1);expect(current.status?.status).toBe('downloaded');expect(install).not.toHaveBeenCalled();
 await act(async()=>current.install());expect(install).toHaveBeenCalledTimes(1);
});
