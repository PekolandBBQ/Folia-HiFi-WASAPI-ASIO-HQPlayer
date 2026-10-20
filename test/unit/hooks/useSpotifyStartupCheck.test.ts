// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSpotifyStartupCheck } from '@/hooks/useSpotifyStartupCheck';
import { useOnlineProviderAccountStore as accounts } from '@/stores/useOnlineProviderAccountStore';
import { useCollectionNavigationStore as navigation } from '@/stores/useCollectionNavigationStore';
import { useSpotifyConnectionStore as connection } from '@/stores/useSpotifyConnectionStore';
import { createSpotifyActivation } from '@/services/onlineMusic/spotifyActivation';
let activation: ReturnType<typeof createSpotifyActivation>;
vi.mock('@/services/onlineMusic/spotifyActivation', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/onlineMusic/spotifyActivation')>(),
    spotifyActivation: { selected:()=>activation.selected(), select:()=>activation.select(), subscribe:(fn:()=>void)=>activation.subscribe(fn) },
}));
const mock=vi.hoisted(()=>({run:vi.fn(),reset:vi.fn(),state:vi.fn()}));
vi.mock('@/services/onlineMusic/spotifyReadiness',()=>({spotifyReadiness:mock}));
// Exercise the real React subscriptions and navigation/store boundary without launching apps.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
const playlist={source:'online' as const,providerId:'spotify' as const,type:'playlist',id:'liked',name:'已点赞'};
async function mount(){const host=document.createElement('div');root=createRoot(host);await act(async()=>{root.render(React.createElement(function Probe(){useSpotifyStartupCheck();return null;}));});}
beforeEach(()=>{activation=createSpotifyActivation();vi.clearAllMocks();accounts.setState({accounts:{spotify:{user:{id:'listener',nickname:'listener'}}} as any});navigation.getState().clear();connection.setState({open:false,pending:false});mock.state.mockReturnValue({status:'idle',retries:0});mock.run.mockResolvedValue(true);});
afterEach(()=>{act(()=>root?.unmount());});
it('does not connect from saved account/provider state; starts only after explicit Spotify selection',async()=>{await mount();expect(mock.run).not.toHaveBeenCalled();await act(async()=>{accounts.setState({activeProviderId:'spotify'});});expect(mock.run).not.toHaveBeenCalled();await act(async()=>{activation.select();});expect(mock.run).toHaveBeenCalledOnce();expect(connection.getState().open).toBe(false);});
it('background failure waits for a Spotify playlist click',async()=>{mock.state.mockReturnValue({status:'failed',retries:3,detail:'连接未响应'});mock.run.mockResolvedValue(false);await mount();expect(connection.getState().open).toBe(false);await act(async()=>{navigation.getState().openRoot(playlist,'home');});expect(connection.getState()).toMatchObject({open:true,authorizeOnOpen:false,failureDetail:'已自动重试 3 次，仍未完成连接。连接未响应'});});
it('does not open before the third retry or for another provider',async()=>{mock.state.mockReturnValue({status:'failed',retries:2});mock.run.mockResolvedValue(false);await mount();await act(async()=>{navigation.getState().openRoot(playlist,'home');});expect(connection.getState().open).toBe(false);mock.state.mockReturnValue({status:'failed',retries:3});await act(async()=>{navigation.getState().openRoot({...playlist,providerId:'netease'},'home');});expect(connection.getState().open).toBe(false);});
it('does not open if the user leaves the playlist while checks run',async()=>{let done!:(v:boolean)=>void;mock.run.mockImplementation(()=>new Promise(resolve=>{done=resolve}));await mount();await act(async()=>{navigation.getState().openRoot(playlist,'home');navigation.getState().clear();mock.state.mockReturnValue({status:'failed',retries:3});done(false);});expect(connection.getState().open).toBe(false);});
