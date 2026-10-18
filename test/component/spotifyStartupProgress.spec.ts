import {test,expect} from './fixtures';
// Render the same lower-left progress component used by the full player.
test('Spotify startup phases are visible and truthful in Chinese',async({page,mount})=>{
 await page.addInitScript(()=>localStorage.setItem('i18nextLng','zh-CN'));
 await mount('playbackPreparation');
 for(const [phase,label] of [['spotifyLaunch','正在加载 Spotify'],['spotifyHandshake','正在与 Spotify 建立握手'],['spotifyReady','Spotify 握手成功']]){
  await page.getByRole('button',{name:phase,exact:true}).click();
  await expect(page.locator('[data-playback-load] [role=status]')).toHaveText(label);
  await expect(page.locator('[data-playback-load] progress')).not.toHaveAttribute('value');
 }
});
