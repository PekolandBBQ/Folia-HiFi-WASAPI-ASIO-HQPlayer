// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'postcss';
import type { SpotifyConnection } from '@/hooks/useSpotifyConnection';

// Exact portal, keyboard and scroll partition checks; jsdom does not prove rendered pixels.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/app/home/SpotifyConnectionSteps', () => ({
    default: () => React.createElement('div', null,
        React.createElement('button', { 'data-testid': 'body-control' }, 'body'),
        React.createElement('p', null, 'Long content '.repeat(500))),
    connectionButtonClass: 'spotify-setup-button',
}));
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';

let root: Root | undefined;
let container: HTMLDivElement;
const connection = () => ({ step: 'ready', checking: false, finishing: false, error: null,
    close: vi.fn(), finish: vi.fn(), inspect: vi.fn() }) as unknown as SpotifyConnection;
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); container.style.transform = 'translateZ(0)';
    document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root?.unmount()); container.remove(); });

it('portals outside the transformed home host and keeps title/footer outside the body scroll area', async () => {
    const value = connection();
    await act(async () => root!.render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: false })));
    const overlay = document.querySelector<HTMLElement>('.spotify-connection-overlay')!;
    expect(overlay.parentElement).toBe(document.body);
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(overlay.getAttribute('data-folia-keyboard-window')).toBe('true');
    const panel = overlay.querySelector('.spotify-connection-panel')!;
    expect([...panel.children].map(child => child.tagName)).toEqual(['HEADER', 'DIV', 'FOOTER']);
    const scroll = panel.querySelector('.spotify-connection-content')!;
    expect(scroll.querySelector('[aria-label="home.closeLogin"]')).toBeNull();
    expect(scroll.textContent).toContain('spotifyCable.intro');
    expect(panel.querySelector('header [aria-label="home.closeLogin"]')).not.toBeNull();
    expect(panel.querySelector('footer')?.textContent).toContain('spotifyConnection.finish');
    expect(value.finish).not.toHaveBeenCalled();
});

it('keeps Escape and close available without finishing or changing setup', async () => {
    const value = connection();
    await act(async () => root!.render(React.createElement(SpotifyConnectionModal, { connection: value, daylight: false })));
    const overlay = document.querySelector<HTMLElement>('[role=dialog]')!;
    await act(async () => overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(value.close).toHaveBeenCalledTimes(1);
    await act(async () => (overlay.querySelector('[aria-label="home.closeLogin"]') as HTMLButtonElement).click());
    expect(value.close).toHaveBeenCalledTimes(2);
    expect(value.finish).not.toHaveBeenCalled();
    expect(value.inspect).not.toHaveBeenCalled();
});

it('traps keyboard traversal and restores the previous trigger on close', async () => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    await act(async () => root!.render(React.createElement(SpotifyConnectionModal, { connection: connection(), daylight: true })));
    const overlay = document.querySelector<HTMLElement>('[role=dialog]')!;
    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'));
    buttons.at(-1)!.focus();
    await act(async () => buttons.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons.at(-1));
    await act(async () => root!.render(null));
    expect(document.activeElement).toBe(trigger); trigger.remove();
});

describe('bounded viewport CSS contract', () => {
    const css = parse(readFileSync(resolve('src/components/modal/settings/SpotifySetupAppearance.css'), 'utf8'));
    const declarations = (selector: string) => {
        const values: Record<string, string> = {};
        css.walkRules(rule => { if (rule.selector === selector && rule.parent?.type !== 'atrule')
            rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; }); });
        return values;
    };
    it('fixes the overlay above app/player layers with viewport margins and centered placement', () => {
        const overlay = declarations('.spotify-connection-overlay');
        expect(overlay).toMatchObject({ position: 'fixed', inset: '0', height: '100dvh', 'z-index': '2200',
            'align-items': 'center', 'justify-content': 'center', overflow: 'hidden', 'box-sizing': 'border-box' });
        expect(overlay.padding).toContain('16px');
    });
    it('caps the panel to available viewport space and scrolls only its middle content', () => {
        expect(declarations('.spotify-connection-panel')).toMatchObject({ display: 'flex', 'flex-direction': 'column',
            'min-height': '0', 'max-height': 'min(calc(100dvh - 32px), 100%)', overflow: 'hidden' });
        expect(declarations('.spotify-connection-content')).toMatchObject({ 'min-height': '0', flex: '1 1 auto',
            'overflow-y': 'auto', 'overscroll-behavior': 'contain' });
        expect(declarations('.spotify-connection-header,\n.spotify-connection-footer').flex).toBe('0 0 auto');
    });
});
