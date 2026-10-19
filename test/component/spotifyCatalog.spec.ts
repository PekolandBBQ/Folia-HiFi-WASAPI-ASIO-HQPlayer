import {test,expect} from './fixtures';

// Exercise real shared UI/adapter/store; the explicit IPC fixture is not a Spotify account or audio test.
const id='0123456789012345678901';
for(const mode of ['dark','light','compact'] as const)test(`Spotify artist and album search/subscriptions (${mode})`,async({page})=>{
 if(mode==='compact')await page.setViewportSize({width:680,height:760});
 await page.addInitScript((key)=>{
  const state={artist:false,album:false,calls:[] as any[],failNext:false};(window as any).__catalogState=state;
  const raw=(type:string)=>({id:key,type,name:'Remote '+type,images:[]});
  (window as any).electron={spotify:{request:async(input:any)=>{
   state.calls.push(input);
   if(input.action==='search')return {items:[],total:0,next:false};
   if(input.action==='searchArtists'||input.action==='searchAlbums')return {items:[raw(input.action==='searchArtists'?'artist':'album')],total:1,next:false};
   if(input.action==='subscriptionStatus')return {subscribed:state[input.collectionType as 'artist'|'album']};
   if(input.action==='subscribeCollection'){
    if(state.failNext){state.failNext=false;return {spotifyError:{code:'unavailable',detail:'Spotify 尚未确认收藏操作，原状态保留。'}};}
    state[input.collectionType as 'artist'|'album']=input.subscribed;
    return {id:key,type:input.collectionType,subscribed:input.subscribed,confirmed:true,accountId:'me'};
   }
   if(input.action==='artists'||input.action==='albums'){const type=input.action==='artists'?'artist':'album';return {items:state[type]?[raw(type)]:[],next:false};}
   if(input.action==='status')return {id:'me',display_name:'Listener'};
   throw Error('Unexpected fixture request '+input.action);
  }}};
 },id);
 await page.goto(`/dev-probe.html?probe=spotifyCatalog${mode==='light'?'&daylight=1':''}`);
 await page.getByRole('button',{name:'Artists',exact:true}).click();
 await page.screenshot({path:`test-results/spotify-catalog-search-${mode}.png`,fullPage:true});
 await page.getByRole('button',{name:'Remote artist',exact:true}).click();
 const follow=page.getByRole('button',{name:'Follow artist',exact:true});await expect(follow).toBeEnabled();
 await page.evaluate(()=>{(window as any).__catalogState.failNext=true;});await follow.click();
 await expect(page.getByRole('alert')).toContainText('Spotify 尚未确认');await expect(follow).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__catalogState.artist)).toBe(false);
 await follow.click();await expect(page.getByRole('button',{name:'Unfollow',exact:true})).toBeEnabled();
 await expect(page.getByTestId('confirmed-favorites')).toHaveText('Remote artist');
 await page.screenshot({path:`test-results/spotify-catalog-artist-${mode}.png`,fullPage:true});
 await page.getByRole('button',{name:'Unfollow',exact:true}).click();await expect(follow).toBeEnabled();
 await expect(page.getByTestId('confirmed-favorites')).toBeEmpty();
 await page.getByRole('button',{name:'Back to search'}).click();await expect(page.getByRole('button',{name:'Artists',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Albums',exact:true}).click();await page.getByRole('button',{name:'Remote album',exact:true}).click();
 const save=page.getByRole('button',{name:'Save album',exact:true});await expect(save).toBeEnabled();await save.click();
 await expect(page.getByRole('button',{name:'Remove from library',exact:true})).toBeEnabled();await expect(page.getByTestId('confirmed-favorites')).toHaveText('Remote album');
 await page.getByRole('button',{name:'Remove from library',exact:true}).click();await expect(save).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__catalogState.album)).toBe(false);
 await page.screenshot({path:`test-results/spotify-catalog-${mode}.png`,fullPage:true});
});
