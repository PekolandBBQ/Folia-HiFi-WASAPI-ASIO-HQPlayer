// @vitest-environment jsdom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnlineProviderConnectPanel from '@/library/suites/grid/account/OnlineProviderConnectPanel';
import OnlineProviderSwitcher from '@/library/suites/grid/account/OnlineProviderSwitcher';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';
import type { ProviderAccountSummary } from '@/types/onlineMusic';

// test/unit/onlineMusic/spotifyProviderVisibility.test.ts — adapt upstream f358c44d visibility contracts to the existing Spotify entry.
// React, provider availability and both production components are real; i18n and the optional desktop bridge are boundaries.
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: vi.fn() }, useTranslation: () => ({ t: (key: string) => key }) }));
const externalFetch = vi.hoisted(() => {
    const request = vi.fn(async () => { throw new Error('External network is disabled in provider visibility tests'); });
    vi.stubGlobal('fetch', request); return request;
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; delete window.electron; expect(externalFetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

function providers(desktop = false): ProviderAccountSummary[] {
    if (desktop) window.electron = { spotify: { request: vi.fn() } } as unknown as typeof window.electron;
    else delete window.electron;
    return [
        { providerId: 'spotify', displayName: 'Spotify', shortName: 'Spotify', availability: spotifyProvider.getAvailability!() },
        { providerId: 'netease', displayName: '网易云音乐', shortName: '网易云', availability: { configured: true } },
        { providerId: 'qq', displayName: 'QQ 音乐', shortName: 'QQ', availability: { configured: false, reason: 'not-configured' } },
    ].map(provider => ({ status: 'anonymous', user: null, collections: [], ...provider })) as ProviderAccountSummary[];
}
const props = { isDaylight: true, activeProviderId: 'spotify', onSelect: vi.fn(), onLogout: vi.fn(), onBackToPlayer: vi.fn() };

describe('Spotify provider visibility in the existing entry', () => {
    it.each([true, false])('hides unavailable desktop login while retaining configurable providers (daylight=%s)', isDaylight => {
        const entries = providers();
        expect(entries[0].availability).toEqual({ configured: false, reason: 'runtime-unavailable' });
        const html = renderToStaticMarkup(createElement(OnlineProviderConnectPanel, {
            providers: entries, isDaylight, title: 'Login', prompt: '', getActionLabel: p => p.displayName, onSelect: vi.fn(),
        }));
        expect(html).not.toContain('Spotify'); expect(html).toContain('网易云音乐'); expect(html).toContain('QQ 音乐');
    });
    it('uses the first visible fallback when the stored active provider is unavailable or missing', () => {
        for (const activeProviderId of ['spotify', 'missing-provider']) {
            const html = renderToStaticMarkup(createElement(OnlineProviderSwitcher, { ...props, providers: providers(), activeProviderId }));
            expect(html).not.toContain('Spotify'); expect(html).toContain('网易云音乐');
        }
    });
    it('renders no switcher when all providers are runtime-unavailable', () => {
        expect(renderToStaticMarkup(createElement(OnlineProviderSwitcher, { ...props, providers: providers().slice(0, 1) }))).toBe('');
    });
    it.each([false, true])('renders and selects only visible menu entries (desktop=%s)', desktop => {
        const entries = providers(desktop), selected = vi.fn(), element = document.createElement('div');
        root = createRoot(element);
        act(() => root!.render(createElement(OnlineProviderSwitcher, { ...props, providers: entries, onSelect: selected })));
        act(() => element.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
        const menu = element.querySelector('[role="menu"]')!;
        expect(menu.textContent?.includes('Spotify')).toBe(desktop);
        const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        expect(buttons).toHaveLength(desktop ? 3 : 2);
        expect(buttons.at(-1)!.disabled).toBe(true);
        act(() => buttons[0].click());
        expect(selected).toHaveBeenCalledWith(entries[desktop ? 0 : 1]);
    });
    it('keeps configured desktop Spotify available in both existing components', () => {
        const entries = providers(true);
        expect(entries[0].availability).toEqual({ configured: true });
        const login = renderToStaticMarkup(createElement(OnlineProviderConnectPanel, {
            providers: entries, isDaylight: true, title: 'Login', prompt: '', getActionLabel: p => p.displayName, onSelect: vi.fn(),
        }));
        const switcher = renderToStaticMarkup(createElement(OnlineProviderSwitcher, { ...props, providers: entries }));
        expect(login).toContain('Spotify'); expect(switcher).toContain('Spotify');
    });
});
