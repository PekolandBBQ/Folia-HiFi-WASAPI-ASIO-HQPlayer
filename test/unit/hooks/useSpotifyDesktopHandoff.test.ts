// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useSpotifyDesktopHandoff} from '@/hooks/useSpotifyDesktopHandoff';
import {usePlaybackStore as playback} from '@/stores/usePlaybackStore';
import {useAudioSettingsStore as audio} from '@/stores/useAudioSettingsStore';
import {useSpotifyHandoffStore as handoff} from '@/stores/useSpotifyHandoffStore';
const mock=vi.hoisted(()=>({detail:vi.fn(),pending:vi.fn(()=>false)}));
vi.mock('@/hooks/useSpotifyRepeatMode',()=>({useSpotifyRepeatMode:()=>{}}));
vi.mock('@/services/onlineMusic/omni',()=>({omni:{getSongDetail:mock.detail}}));
vi.mock('@/services/onlineMusic/spotifyReadiness',()=>({spotifyReadiness:{}}));
vi.mock('@/services/playbackSourceRequest',()=>({hasPendingPlaybackSourceRequest:mock.pending}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const song=(id:string)=>({id,name:id,sourceRef:{kind:'online',providerId:'spotify',mediaId:id}} as any);
const a=song('a'.repeat(22)),b=song('b'.repeat(22)),c=song('c'.repeat(22));
let root:Root,receive:(event:any)=>void;const play=vi.fn(async()=>{}),next=vi.fn(),autoplay={current:true};
async function mount(){Object.defineProperty(window,'electron',{configurable:true,value:{spotify:{onExternalSelection:(fn:any)=>{receive=fn;return ()=>{};}}}});root=createRoot(document.createElement('div'));await act(async()=>{root.render(React.createElement(function Probe(){useSpotifyDesktopHandoff(play,autoplay,next);return null;}));});}
const event=(phase:string,extra={})=>({phase,token:1,previousTrackId:a.id,trackId:b.id,positionMs:1700,...extra});
beforeEach(()=>{vi.clearAllMocks();mock.pending.mockReturnValue(false);playback.setState({currentSong:a,playQueue:[a,b,c]});audio.setState({loopMode:'off'});handoff.setState({pending:null});mock.detail.mockResolvedValue(b);});
afterEach(()=>{act(()=>root?.unmount());});
it('manual desktop selection shows confirmation and follow keeps queue and playlist view',async()=>{
 await mount();await act(async()=>receive(event('paused')));expect(handoff.getState().pending?.trackId).toBe(b.id);expect(play).not.toHaveBeenCalled();
 await act(async()=>receive(event('follow')));expect(play).toHaveBeenCalledWith(b,[a,b,c],false,{initialPosition:1.7,shouldNavigateToPlayer:false});
});
for(const mode of ['off','all','one'] as const)it('natural completion in '+mode+' has one queue owner',async()=>{
 audio.setState({loopMode:mode});await mount();await act(async()=>{receive(event('paused',{naturalEnd:true}));receive(event('advance'));});
 expect(handoff.getState().pending).toBeNull();
 if(mode==='one'){expect(play).toHaveBeenCalledWith(a,[a,b,c],false,{initialPosition:0,shouldNavigateToPlayer:false});expect(next).not.toHaveBeenCalled();}
 else{expect(next).toHaveBeenCalledTimes(1);expect(play).not.toHaveBeenCalled();}
});
it('a stale observation or a pending new selection cannot stop the current song',async()=>{
 await mount();playback.setState({currentSong:c});await act(async()=>receive(event('paused')));expect(handoff.getState().pending).toBeNull();
 playback.setState({currentSong:a});mock.pending.mockReturnValue(true);await act(async()=>receive(event('paused')));expect(handoff.getState().pending).toBeNull();
});
it('same-song external seek reuses the current song and realigns audio without a change-song dialog',async()=>{
 await mount();await act(async()=>receive(event('paused',{trackId:a.id,externalSeek:true,positionMs:45000})));
 expect(handoff.getState().pending).toBeNull();
 await act(async()=>receive(event('follow',{trackId:a.id,externalSeek:true,positionMs:45000})));
 expect(mock.detail).not.toHaveBeenCalled();
 expect(play).toHaveBeenCalledWith(a,[a,b,c],false,{initialPosition:45,shouldNavigateToPlayer:false});
});
