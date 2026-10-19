// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useSpotifyRepeatMode} from '@/hooks/useSpotifyRepeatMode';
import {useOnlineProviderAccountStore as accounts} from '@/stores/useOnlineProviderAccountStore';
import {useAudioSettingsStore as audio} from '@/stores/useAudioSettingsStore';
const request=vi.hoisted(()=>vi.fn());
vi.mock('@/services/onlineMusic/omni',()=>({omni:{providerRepeatMode:request}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
async function mount(){root=createRoot(document.createElement('div'));await act(async()=>{root.render(React.createElement(function Probe(){useSpotifyRepeatMode();return null;}));});}
beforeEach(()=>{vi.useFakeTimers();request.mockReset();accounts.setState({activeProviderId:'netease'});audio.setState({loopMode:'off'});});
afterEach(()=>{act(()=>root?.unmount());vi.useRealTimers();});
for(const mode of ['off','all','one'] as const)it('imports actual '+mode+' when switching to Spotify',async()=>{
 request.mockResolvedValue(mode);await mount();expect(request).not.toHaveBeenCalled();
 await act(async()=>{accounts.setState({activeProviderId:'spotify'});});expect(audio.getState().loopMode).toBe(mode);
 await act(async()=>{accounts.setState({activeProviderId:'netease'});});expect(audio.getState().loopMode).toBe('off');
});
it('writes using fresh remote mode and changes the icon only after confirmation',async()=>{
 request.mockResolvedValue('off');accounts.setState({activeProviderId:'spotify'});await mount();
 let done!:(v:string)=>void;
 request.mockResolvedValueOnce('all').mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));
 await act(async()=>{audio.getState().handleToggleLoopMode();});expect(request).toHaveBeenLastCalledWith('spotify','one');expect(audio.getState().loopMode).toBe('off');
 request.mockResolvedValue('one');await act(async()=>{done('one');});expect(audio.getState().loopMode).toBe('one');
});
it('ignores an old poll when a mode write overtakes it',async()=>{
 let old!:(v:string)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve;}));
 accounts.setState({activeProviderId:'spotify'});await mount();request.mockResolvedValue('all');
 await act(async()=>{audio.getState().handleToggleLoopMode();});expect(audio.getState().loopMode).toBe('all');
 await act(async()=>{old('off');});expect(audio.getState().loopMode).toBe('all');
});
it('does not apply late readback after leaving Spotify',async()=>{
 let done!:(v:string)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));
 accounts.setState({activeProviderId:'spotify'});await mount();
 await act(async()=>{accounts.setState({activeProviderId:'netease'});done('one');});expect(audio.getState().loopMode).toBe('off');
});
