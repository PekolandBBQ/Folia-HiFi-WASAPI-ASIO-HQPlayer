// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSpotifyRepeatMode } from '@/hooks/useSpotifyRepeatMode';
import { useSpotifyPlaybackSetup } from '@/hooks/useSpotifyPlaybackSetup';
import { useOnlineProviderAccountStore as accounts } from '@/stores/useOnlineProviderAccountStore';
import { spotifyActivation } from '@/services/onlineMusic/spotifyActivation';
import { automaticCableStatus } from '../onlineMusic/spotifyCableFixture';
import SpotifyDesktopSetup from '@/components/app/home/SpotifyDesktopSetup';

// test/unit/hooks/spotifyColdSelection.test.ts — actual dormant pollers with a previously selected Spotify account.
const io = vi.hoisted(()=>({repeat:vi.fn(),setup:vi.fn()}));
vi.mock('@/services/onlineMusic/omni',()=>({omni:{hasProviderPlaybackSetup:()=>true,providerRepeatMode:io.repeat,requestProviderPlaybackSetup:io.setup}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('does not poll or initialize Spotify until selected, then starts the existing setup/repeat owners',async()=>{
    accounts.setState({activeProviderId:'spotify'});
    io.repeat.mockResolvedValue('off'); io.setup.mockResolvedValue(automaticCableStatus());
    const desktop=vi.fn(async()=>({enabled:true,installations:[],versions:{spicetify:'test',cable:'test'},
        install:{phase:'idle',busy:false},systemOutput:{state:'unknown',names:[]}}));
    Object.defineProperty(window,'electron',{configurable:true,value:{spotify:{request:desktop}}});
    const root=createRoot(document.createElement('div'));
    function Probe(){useSpotifyRepeatMode();useSpotifyPlaybackSetup(state=>state.busy);return React.createElement(SpotifyDesktopSetup,{onMode:()=>{},onReady:()=>{}});}
    try {
        await act(async()=>{root.render(React.createElement(Probe));});
        expect(io.repeat).not.toHaveBeenCalled();expect(io.setup).not.toHaveBeenCalled();expect(desktop).not.toHaveBeenCalled();
        await act(async()=>{spotifyActivation.select();});
        expect(io.repeat).toHaveBeenCalledWith('spotify');
        expect(io.setup).toHaveBeenCalledWith('spotify',{operation:'status'},undefined);
        expect(desktop).toHaveBeenCalledWith({action:'desktopSetup',operation:'status'});
    }finally{act(()=>root.unmount());delete window.electron;}
});
