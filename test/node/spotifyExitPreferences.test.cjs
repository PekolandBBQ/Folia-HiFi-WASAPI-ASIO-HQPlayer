'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createDesktopLifecycle}=require('../../electron/spotify/desktopLifecycle.cjs');
// Lifecycle checks use temporary preferences and synthetic processes; never touch Spotify.
test('source changes and default quit retain Spotify without a dialog; opt-in persists and only stops selected identities',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-exit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const running=[{pid:123,started:'now',exe:'C:/Spotify.exe'},{pid:456,started:'now',exe:'C:/Other.exe'}];const stopped=[];
 const args={directory,apps:'',bridge:{},ready:Promise.resolve(),log:()=>{},dialog:{showMessageBox:()=>{throw Error('No exit prompt allowed');}},parent:()=>null,
 discovery:async()=>({candidates:[{id:'desktop',exe:'C:/Spotify.exe'}],running}),stop:p=>{stopped.push(p.pid);}};
 const first=createDesktopLifecycle(args);
 assert.deepEqual(first.preferences(),{quitOnFoliaExit:false});
 await first.offerExit('source');await first.offerExit('quit');assert.deepEqual(stopped,[]);
 first.setPreferences({quitOnFoliaExit:true});const second=createDesktopLifecycle(args);
 assert.equal(second.preferences().quitOnFoliaExit,true);await second.offerExit('source');assert.deepEqual(stopped,[]);
 await second.offerExit('quit');assert.deepEqual(stopped,[123]);
 second.setPreferences({quitOnFoliaExit:false});await second.offerExit('quit');assert.deepEqual(stopped,[123]);
});
test('exit refuses a reused process ID',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folia-exit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let scans=0;
 const lifecycle=createDesktopLifecycle({directory,log:()=>{},discovery:async()=>({candidates:[{id:'desktop',exe:'C:/Spotify.exe'}],running:[{pid:123,started:++scans===1?'old':'new',exe:'C:/Spotify.exe'}]}),stop:()=>{throw Error('PID reused');}});
 lifecycle.setPreferences({quitOnFoliaExit:true});await lifecycle.offerExit('quit');
});

