// @vitest-environment jsdom
import React, { act, StrictMode, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotifyConnection } from '@/hooks/useSpotifyConnection';
import type { ProviderPlaybackSetupStatus } from '@/types/onlineMusic';

// Independent r11 DOM review: real modal, steps, cable fields, artwork and framer-motion.
// Only provider I/O and translation lookup are isolated; this does not prove pixels or native audio.
const mock = vi.hoisted(() => ({ state: { status: null as ProviderPlaybackSetupStatus | null, busy: false }, run: vi.fn() }));
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useSpotifyPlaybackSetup', () => ({ useSpotifyPlaybackSetup: () => mock.state }));
vi.mock('@/services/onlineMusic/spotifyPlaybackSetup', () => ({ spotifyPlaybackSetup: { canRun: () => !mock.state.busy, run: mock.run } }));
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';
import SpotifyPublicArtwork from '@/components/folia-grid/SpotifyPublicArtwork';
import { PolaroidCardCover, type GridItem } from '@/components/folia-grid/polaroidCardParts';
import { hasBlockingWindow } from '@/utils/keyboardTargets';

let host: HTMLDivElement, root: Root;
const coverA = 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02111111111111111111111111';
const coverB = 'https://i.scdn.co/image/ab67616d00001e02222222222222222222222222';
const setup = (): ProviderPlaybackSetupStatus => ({ backend: 'vb-cable', state: 'stopped', spotifyRunning: true, driverInstalled: true,
    selection: { connectDeviceId: 'desktop', renderDeviceId: 'render', captureDeviceId: 'capture', internal44100Confirmed: true, spotifyOnlyConfirmed: true, defaultsConfirmed: true },
    devices: { spotify: [{ id: 'desktop', name: 'Official desktop', type: 'computer', isActive: true, restricted: false, selectable: true }], render: [{ id: 'render', name: 'CABLE Input' }], capture: [{ id: 'capture', name: 'CABLE Output' }] }
});
const connection = (patch: Partial<SpotifyConnection> = {}) => ({ step: 'cable', checking: false, finishing: false, error: null, catalogAuthorized: true, catalogVerifying: false,
    close: vi.fn(), finish: vi.fn(), inspect: vi.fn(), setup: mock.state, login: { qrState: 'idle', start: vi.fn() }, ...patch }) as unknown as SpotifyConnection;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mock.state = { status: setup(), busy: false }; mock.run.mockReset();
    host = document.createElement('div'); host.style.transform = 'translateZ(0)'; document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (element: React.ReactNode) => act(async () => root.render(element));
const click = async (element: Element) => act(async () => (element as HTMLElement).click());
const textButton = (key: string) => [...document.querySelectorAll('button')].find(el => el.textContent === key)!;
const key = async (element: Element, value: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true });
    await act(async () => { element.dispatchEvent(event); }); return event;
};

describe('independent real modal integration', () => {
    it('preserves four owner theme variables and updates them while open without theme writes', async () => {
        const palette = { '--bg-color': '#f2eee8', '--text-primary': '#271f1c', '--text-secondary': '#715f54', '--text-accent': '#ac310c' };
        for (const [name, value] of Object.entries(palette)) host.style.setProperty(name, value);
        const initialOwnerStyle = host.getAttribute('style'), initialBodyStyle = document.body.getAttribute('style');
        const value = connection();
        await render(React.createElement('div', { style: { transform: 'translateZ(0)' } }, React.createElement(SpotifyConnectionModal, { connection: value, daylight: true })));
        const modal = document.querySelector<HTMLElement>('[role=dialog]')!;
        for (const [name, value] of Object.entries(palette)) expect(modal.style.getPropertyValue(name)).toBe(value);
        expect(host.getAttribute('style')).toBe(initialOwnerStyle); expect(document.body.getAttribute('style')).toBe(initialBodyStyle);
        await click(textButton('spotifyConnection.back'));
        await act(async () => { host.style.setProperty('--text-accent', '#227755'); host.classList.add('theme-changed'); await Promise.resolve(); });
        expect(modal.style.getPropertyValue('--text-accent')).toBe('#227755');
        expect(modal.querySelector('[data-testid=spotify-connect-desktop]')).not.toBeNull();
        expect(value.close).not.toHaveBeenCalled(); expect(value.finish).not.toHaveBeenCalled();
        const updatedOwnerStyle = host.getAttribute('style'); await render(null);
        expect(host.getAttribute('style')).toBe(updatedOwnerStyle); expect(document.body.getAttribute('style')).toBe(initialBodyStyle);
    });
    it('keeps explanatory progress and resume text fully in the one middle scroller', async () => {
        await render(React.createElement(SpotifyConnectionModal, { connection: connection(), daylight: false }));
        const modal = document.querySelector<HTMLElement>('[role=dialog]')!;
        const scroll = modal.querySelector('.spotify-connection-content')!;
        expect(scroll.querySelector('.spotify-connection-progress')).not.toBeNull();
        expect(scroll.querySelector('.spotify-connection-intro')).not.toBeNull();
        expect(scroll.querySelector('.spotify-connection-resume')).not.toBeNull();
        expect(modal.querySelector('header')?.textContent).toBe('home.loginTitleSpotify');
        expect(modal.querySelector('footer')?.textContent).toBe('spotifyConnection.back');
    });
    it('mounts real cable controls in portal with distinct chrome and content, without native mutation', async () => {
        const value = connection();
        await render(React.createElement(StrictMode, null, React.createElement(SpotifyConnectionModal, { connection: value, daylight: false })));
        const modal = document.querySelector('[role=dialog]')!;
        expect(modal.parentElement).toBe(document.body);
        expect(host.querySelector('[role=dialog]')).toBeNull();
        expect(document.activeElement).toBe(modal);
        expect(hasBlockingWindow()).toBe(true);
        expect(modal.querySelectorAll('select')).toHaveLength(2);
        expect([...modal.querySelectorAll('select')].map(el => el.value)).toEqual(['render', 'capture']);
        expect(modal.querySelectorAll('input:checked')).toHaveLength(2);
        expect(modal.textContent).toContain('spotifyCable.clientOutputStep');
        expect(modal.textContent).not.toContain('spotifyCable.defaultsConfirmed');
        expect(modal.querySelector('header button[aria-label="home.closeLogin"]')).not.toBeNull();
        expect(modal.querySelector('.spotify-connection-content')?.contains(textButton('spotifyConnection.back'))).toBe(false);
        expect(mock.run.mock.calls.length).toBeGreaterThan(0);
        expect(mock.run.mock.calls.every(([action]) => action.operation === 'devices')).toBe(true);
        expect(value.finish).not.toHaveBeenCalled();
    });
    it('closes on Escape, restores trigger and reopens from observed current step', async () => {
        const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
        const value = connection();
        await render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: false }));
        await click(textButton('spotifyConnection.back'));
        expect(document.querySelector('[data-testid=spotify-connect-desktop]')).not.toBeNull();
        const closed = await key(document.activeElement!, 'Escape');
        expect(closed.defaultPrevented).toBe(true); expect(value.close).toHaveBeenCalledTimes(1);
        await render(null); expect(document.activeElement).toBe(trigger); expect(hasBlockingWindow()).toBe(false);
        await render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: true }));
        expect(document.querySelector('[data-testid=spotify-connect-cable]')).not.toBeNull();
        expect(textButton('spotifyConnection.continue')).toBeUndefined();
        expect(value.finish).not.toHaveBeenCalled();
        await render(null); expect(document.activeElement).toBe(trigger); trigger.remove();
    });
    it('removes the body portal after actual AnimatePresence exit and reopens one modal', async () => {
        let reopen!: () => void;
        const base = connection();
        function Probe() {
            const [open, setOpen] = useState(true); reopen = () => setOpen(true);
            return React.createElement(AnimatePresence, null, open ? React.createElement(SpotifyConnectionModal, {
                key: 'wizard', connection: { ...base, close: () => setOpen(false) }, daylight: false,
            }) : null);
        }
        await render(React.createElement(Probe));
        await key(document.querySelector('[role=dialog]')!, 'Escape');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
        expect(document.querySelector('[role=dialog]')).toBeNull(); expect(hasBlockingWindow()).toBe(false);
        await act(async () => reopen());
        expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
        expect(document.activeElement).toBe(document.querySelector('[role=dialog]'));
    });
    it('traps both boundaries over real selects, checkboxes and vendor links', async () => {
        await render(React.createElement(SpotifyConnectionModal, { connection: connection(), daylight: false }));
        const modal = document.querySelector<HTMLElement>('[role=dialog]')!;
        const nodes = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')];
        expect(nodes.some(el => el.tagName === 'A')).toBe(true);
        await key(modal, 'Tab', true); expect(document.activeElement).toBe(nodes.at(-1));
        await key(nodes.at(-1)!, 'Tab'); expect(document.activeElement).toBe(nodes[0]);
        await key(nodes[0], 'Tab', true); expect(document.activeElement).toBe(nodes.at(-1));
    });
    it('does not show readiness on failed/checking state and retains retry handler', async () => {
        const value = connection({ step: 'ready', error: 'readFailed' });
        await render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: false }));
        expect(document.querySelector('[data-testid=spotify-connect-ready]')).toBeNull();
        expect(document.querySelector('[aria-current=step]')).toBeNull();
        expect(textButton('spotifyConnection.finish')).toBeUndefined();
        await click(textButton('spotifyConnection.checkAgain')); expect(value.inspect).toHaveBeenCalledOnce();
        await render(React.createElement(SpotifyConnectionModal, { connection: { ...value, error: null, checking: true }, daylight: true }));
        expect(document.querySelector('[role=status]')?.textContent).toBe('spotifyConnection.checking');
        expect(textButton('spotifyConnection.finish')).toBeUndefined();
    });
    it('back and continue review only; finish delegates only explicit ready click', async () => {
        const value = connection({ step: 'ready' });
        await render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: false }));
        await click(textButton('spotifyConnection.back'));
        expect(document.querySelector('[data-testid=spotify-connect-cable]')).not.toBeNull();
        expect(value.finish).not.toHaveBeenCalled();
        await click(textButton('spotifyConnection.continue'));
        expect(document.querySelector('[data-testid=spotify-connect-ready]')).not.toBeNull();
        await click(textButton('spotifyConnection.finish')); expect(value.finish).toHaveBeenCalledOnce();
        expect(mock.run.mock.calls.every(([action]) => action.operation === 'devices')).toBe(true);
    });
});

describe('independent public artwork states and source races', () => {
    const art = (source?: string, unavailable = false) => render(React.createElement(SpotifyPublicArtwork, { source, title: 'Public song', unavailable }));
    const dispatch = async (image: HTMLImageElement, type: string) => act(async () => { image.dispatchEvent(new Event(type)); });
    it('has no image fetch for missing metadata and no infinite spinner', async () => {
        await art(); expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('[role=img]')?.getAttribute('aria-label')).toBe('spotifyLibrary.artworkUnavailable');
        expect(host.querySelector('.animate-spin')).toBeNull();
    });
    it('loads valid source privately, preserves aspect ratio and dims unavailable track', async () => {
        await art(coverA, true); const image = host.querySelector('img')!;
        expect(image.getAttribute('src')).toBe(coverA); expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(image.classList.contains('object-contain')).toBe(true); expect(image.style.opacity).toBe('0');
        await dispatch(image, 'load'); expect(image.style.opacity).toBe('0.3');
        expect(host.querySelector('[data-testid=spotify-public-artwork-state]')).toBeNull();
    });
    it('does not inherit loaded state or late failure from a replaced source', async () => {
        await art(coverA); const old = host.querySelector('img')!; await dispatch(old, 'load');
        await art(coverB); const next = host.querySelector('img')!;
        expect(next).not.toBe(old); expect(next.style.opacity).toBe('0');
        await dispatch(old, 'error'); expect(host.querySelector('img')).toBe(next);
        await dispatch(next, 'load'); expect(next.style.opacity).toBe('1');
    });
    it('retries a previously failed source after switching away and back', async () => {
        await art(coverA); await dispatch(host.querySelector('img')!, 'error');
        await art(coverB); await dispatch(host.querySelector('img')!, 'load');
        await art(coverA); expect(host.querySelector('img')?.src).toBe(coverA);
    });
    it('cached successfully decoded image does not stay in loading state', async () => {
        const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
        const naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
        Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
        Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 300 });
        try { await art(coverA); expect(host.querySelector('img')?.style.opacity).toBe('1'); expect(host.querySelector('[role=status]')).toBeNull(); }
        finally { if (complete) Object.defineProperty(HTMLImageElement.prototype, 'complete', complete); if (naturalWidth) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', naturalWidth); }
    });
    it.each(['spotify-api', undefined])('keeps owned/Likes artwork branch unchanged: %s', async metadataSource => {
        const item: GridItem = { id: 'track', name: 'Owned song', coverUrl: coverA, rawTrack: { id: 'track', name: 'Owned song', durationMs: 120000, artists: [{ id: 'artist', name: 'Artist' }], album: { id: 'album', name: 'Album', coverUrl: coverA }, sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'track', providerData: metadataSource ? { metadataSource } : {} } } };
        await render(React.createElement(PolaroidCardCover, { item, isUnavailable: false }));
        expect(host.querySelector('img')?.classList.contains('object-cover')).toBe(true);
        expect(host.querySelector('img')?.getAttribute('referrerpolicy')).toBeNull();
        expect(host.querySelector('[data-testid=spotify-public-artwork-state]')).toBeNull();
        expect(host.querySelector('.animate-spin')).not.toBeNull();
    });
});
