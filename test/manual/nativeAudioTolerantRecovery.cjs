const { attach, connect } = require('./remainingHarness.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

// test/manual/nativeAudioTolerantRecovery.cjs — damaged songs recover in place, including paused intent.
async function main() {
    const h = await connect('tolerant-recovery'); const { page, record } = h;
    try {
        for (const backend of process.argv.includes('--browser') ? ['browser'] : ['wasapi-exclusive','asio']) for (const id of ['3B7IskPYaj5cXacvfgF6IS','0vkNVrR3Iqmso4JAUxoyDX']) for (const paused of [false,true]) {
            await page.reload(); await attach(page);
            await record(`${backend}-${id}-${paused ? 'paused' : 'playing'}`, async () => {
                await page.evaluate(async ({backend,id,cold}) => {
                    const r=window.__remaining;
                    const { navidromeApi,getNavidromeConfig }=await import('/src/services/navidromeService.ts');
                    const { buildUnifiedNavidromeSong }=await import('/src/services/playbackAdapters.ts');
                    const { useStatusMessageStore }=await import('/src/stores/useStatusMessageStore.ts');
                    const { saveToCache }=await import('/src/services/db.ts');
                    const c=getNavidromeConfig();
                    const songs=await Promise.all([id,'32sKZLBKwLBsaPv1R0taFe'].map(async id=>{await saveToCache(`navidrome_match_${id}`,{noAutoMatch:true});return buildUnifiedNavidromeSong(navidromeApi.toNavidromeSong(c,await navidromeApi.getSong(c,id)));}));
                    if(cold){const {resolveNavidromePlaybackCarrier}=await import('/src/utils/appPlaybackGuards.ts');const carrier=resolveNavidromePlaybackCarrier(songs[0]);carrier.navidromeData.path+=`:cold-validation-${Date.now()}`;}
                    r.bad=songs[0];r.toasts=[];r.statusOff=useStatusMessageStore.subscribe(s=>{if(s.message)r.toasts.push(s.message);});
                    r.settings.setState({volume:.1,isMuted:false,enableTranscodeFallback:true,loopMode:'all'});
                    r.settings.getState().handleSetNativeAudioProcessingMode('compatibility');
                    r.settings.getState().handleSetNativeAudioOutput(backend,backend==='browser'?'':r.devices.find(d=>d.backend===backend).id);
                    r.native=backend!=='browser';
                    if(!r.native)r.active=()=>[...document.querySelectorAll('audio')].find(a=>a.currentSrc===r.playback.getState().audioSrc);
                    await new Promise(resolve=>setTimeout(resolve,250));
                    await r.entry()(songs[0],songs,false,{shouldNavigateToPlayer:false});
                },{backend,id,cold:process.argv.includes('--cold')});
                await page.waitForFunction(()=>{const t=window.__remaining.active();return t?.readyState===4&&!t.paused&&t.currentTime>.2;},null,{timeout:30000});
                await page.evaluate(async paused=>{const t=window.__remaining.active();if(paused)t.pause();else await t.play();t.currentTime=3;},paused);
                await page.waitForFunction(()=>{const t=window.__remaining.active();return !t.seeking&&t.currentTime>=3;});
                await page.evaluate(async()=>{const r=window.__remaining,t=r.active();r.toasts=[];r.beforeSession=t.session;r.beforeSource=t.currentSrc;r.started=performance.now();if(r.native){await window.electron.nativeAudio.request({action:'pause',session:t.session});t.fail(new Error('DECODE_FAILED'));}else{Object.defineProperty(t,'error',{configurable:true,get:()=>({code:3})});t.dispatchEvent(new Event('error'));delete t.error;}});
                await page.waitForFunction(paused=>{const r=window.__remaining,t=r.active(),s=r.playback.getState();return (r.native?t?.session!==r.beforeSession:t?.currentSrc!==r.beforeSource)&&t?.readyState===4&&!t.error&&t.paused===paused&&t.currentTime>=2.9&&s.audioSrc?.startsWith('folia-transcode:')&&r.getPlaybackSongKey(s.currentSong)===r.getPlaybackSongKey(r.bad);},paused,{timeout:45000});
                const result=await page.evaluate(()=>{const r=window.__remaining,t=r.active(),url=new URL(r.playback.getState().audioSrc);return {position:t.currentTime,paused:t.paused,sameSong:true,recoveryMs:performance.now()-r.started,cacheKey:url.pathname.split('/')[1],errorToasts:r.toasts.filter(m=>m.type==='error')};});
                assert.equal(result.errorToasts.length,0);
                const metadata=JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA,'FoliaNativeReview/profile/transcode-cache',result.cacheKey,'metadata.json'),'utf8'));
                assert.equal(metadata.decodeMode,'tolerant');
                return {...result,decodeMode:metadata.decodeMode,outputStrictlyValidated:true,coldSourceRevision:process.argv.includes('--cold'),fault:'controlled media error; real strict and tolerant FFmpeg'};
            });
            await page.evaluate(()=>{window.__remaining.active()?.pause();window.__remaining.statusOff?.();});
        }
    } finally {await page.evaluate(()=>window.__remaining?.active()?.pause()).catch(()=>{});await h.browser.close();}
    if(h.results.some(r=>r.status==='FAIL'))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
