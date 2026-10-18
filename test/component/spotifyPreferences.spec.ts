import {test,expect} from './fixtures';
// No native processes are started by this preference regression.
test('exit is opt-in and signal path can change without HQPlayer',async({page,mount})=>{
 await page.addInitScript(()=>{
  Object.assign(window,{electron:{platform:'win32',nativeAudio:{supported:true,request:async()=>({})},spotify:{request:async(input:any)=>{
   if(input.preferences)localStorage.setItem('testSpotifyExit',JSON.stringify(input.preferences));
   return JSON.parse(localStorage.getItem('testSpotifyExit')||'{"quitOnFoliaExit":false}');
  }}}});
 });
 const view=await mount('spotifyPreferences');
 const quit=view.getByRole('switch',{name:'Quit Spotify when Folia exits'});
 await expect(quit).toBeEnabled();await expect(quit).toHaveAttribute('aria-checked','false');
 await quit.click();await expect(quit).toHaveAttribute('aria-checked','true');
 await view.getByRole('switch',{name:'Show audio signal path'}).click();
 await expect(view.getByRole('switch',{name:'Show audio signal path'})).toBeEnabled();
 await view.unmount();await page.evaluate(async()=>{await window.mount({story:'spotifyPreferences'});});const again=page.locator('#root');
 await expect(again.getByRole('switch',{name:'Quit Spotify when Folia exits'})).toHaveAttribute('aria-checked','true');
});

