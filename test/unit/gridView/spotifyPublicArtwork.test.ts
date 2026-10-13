// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Artwork failures stay explicit; these DOM tests never request real images or audio.
vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
import SpotifyPublicArtwork from '@/components/folia-grid/SpotifyPublicArtwork';
import { PolaroidCardCover, type GridItem } from '@/components/folia-grid/polaroidCardParts';
let host: HTMLDivElement, root: Root;
const cover = 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02928b6af826fd96cb8bb49874';
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (source?: string) => act(async () => root.render(React.createElement(SpotifyPublicArtwork,
    { source, title: '形', unavailable: false })));
it('displays real source art and suppresses its pending state after load', async () => {
    await render(cover);
    const image = host.querySelector('img')!;
    expect(image.src).toBe(cover); expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(host.textContent).toContain('spotifyLibrary.artworkLoading');
    await act(async () => image.dispatchEvent(new Event('load')));
    expect(image.style.opacity).toBe('1');
    expect(host.querySelector('[data-testid=spotify-public-artwork-state]')).toBeNull();
});
it('distinguishes a missing/failed thumbnail from an indefinitely loading image', async () => {
    await render();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('spotifyLibrary.artworkUnavailable');
    await render(cover);
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role=img]')?.getAttribute('aria-label')).toBe('spotifyLibrary.artworkUnavailable');
    expect(host.textContent).not.toContain('spotifyLibrary.artworkLoading');
});
it('recovers when a new verified image URL arrives after failure', async () => {
    await render(cover); await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    const next = cover.replace('928b6af826fd96cb8bb49874', '11111111111111111111111');
    await render(next);
    expect(host.querySelector('img')?.src).toBe(next);
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(host.querySelector('[role=img]')).toBeNull();
});
it('limits the new missing-state presentation to Spotify public tracks', async () => {
    const track = { id: 'x', name: 'x', durationMs: 1, artists: [], album: { id: '', name: '' },
        sourceRef: { kind: 'online' as const, providerId: 'spotify', mediaId: 'x', providerData: { metadataSource: 'spotify-public-embed' } } };
    const item: GridItem = { id: 'x', name: 'x', rawTrack: track };
    await act(async () => root.render(React.createElement(PolaroidCardCover, { item, isUnavailable: false })));
    expect(host.textContent).toContain('spotifyLibrary.artworkUnavailable');
    await act(async () => root.render(React.createElement(PolaroidCardCover, { item: { ...item, rawTrack: { ...track,
        sourceRef: { ...track.sourceRef, providerData: { metadataSource: 'spotify-api' } } } }, isUnavailable: false })));
    expect(host.textContent).not.toContain('spotifyLibrary.artworkUnavailable');
});
