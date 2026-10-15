// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PolaroidCard, type PolaroidCardProps } from '@/library/suites/grid/shared/PolaroidCard';
import BravaisFocusCardBody from '@/library/suites/bravais/BravaisFocusCardBody';
import type { SongResult } from '@/types';
let root: Root, host: HTMLDivElement;
const song = { id: '0123456789012345678901', name: 'Card A', artists: [], album: { id: 1, name: '' }, durationMs: 10000,
 sourceRef: { kind: 'online', providerId: 'spotify', mediaId: '0123456789012345678901' } } as SongResult;
const base = { item: { id: 'card-a', name: song.name, rawTrack: song }, mode: 'tracks',
 isDaylight: false, theme: {}, t: (key: string) => key, cardWidth: 160, cardHeight: 220, onCenter: () => {} } as Omit<PolaroidCardProps, 'onSelect'>;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 host = document.createElement('div'); document.body.append(host); root = createRoot(host);
 vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('same-looking card always invokes the latest selection callback exactly once', async () => {
 const old = vi.fn(), current = vi.fn();
 await act(async () => root.render(React.createElement(PolaroidCard, { ...base, onSelect: old })));
 await act(async () => root.render(React.createElement(PolaroidCard, { ...base, onSelect: current })));
 await act(async () => (host.querySelector('[data-grid-card-play]') as HTMLElement).click());
 expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(1);
});
it('reused card DOM follows A/B/C identity under rapid changes, without bubbling duplicate plays', async () => {
 const played: string[] = [];
 for (const id of ['A', 'B', 'C', 'A', 'C']) {
  const track = { ...song, id, name: id };
  await act(async () => root.render(React.createElement(PolaroidCard, { ...base, item: { id, name: id, rawTrack: track }, onSelect: () => { played.push(track.id as string); } })));
  await act(async () => (host.querySelector('[data-grid-card-play]') as HTMLElement).click());
 }
 expect(played).toEqual(['A', 'B', 'C', 'A', 'C']);
});

it('wall play and enqueue buttons carry the actual rendered key, not only the recycled slot', async () => {
 const play=vi.fn(), enqueue=vi.fn();
 const actions={ play, enqueue, canOpenAlbum:()=>false, canOpenArtist:()=>false, openAlbum:()=>{}, openArtist:()=>{},
 menuFor:()=>[],runMenu:()=>{},hover:()=>{},togglesCurrent:false };
 await act(async()=>root.render(React.createElement(BravaisFocusCardBody, {slotKey:'0:0:0',
 item:{key:'visible-A',kind:'track',title:'Visible A',subtitle:'',badge:'1'},queued:false,current:false,titleWidth:300,actions})));
 await act(async()=> (host.querySelector('[data-bravais-action=play]') as HTMLElement).click());
 expect(play).toHaveBeenCalledExactlyOnceWith('0:0:0','visible-A');
});
