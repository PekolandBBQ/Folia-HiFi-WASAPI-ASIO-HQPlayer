// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HQPlayerSpotifyExperimentSettings from '../../../src/components/audio/HQPlayerSpotifyExperimentSettings';
import { useHQPlayerSettingsStore } from '../../../src/stores/useHQPlayerSettingsStore';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS as defaults, HQPLAYER_SPOTIFY_EXPERIMENT_KEY as key } from '../../../src/utils/hqplayerSpotifyExperiment';
import en from '../../../src/i18n/locales/en';

// test/unit/nativeAudio/hqplayerSpotifyExperimentControls.test.ts — real React controls save settings without invoking playback.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (name: string, values?: Record<string, number>) => {
    const [section, field] = name.split('.');
    const text: string = (en as any)[section]?.[field] || name;
    return text.replace(/\{\{(\w+)\}\}/g, (_match, field) => String(values?.[field]));
} }) }));
let host: HTMLDivElement, root: Root;
const request = vi.fn();
const checkbox = () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
const numbers = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type=number]'));
const edit = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(window, { electron: { platform: 'win32', nativeAudio: { supported: true, request } } });
    localStorage.clear(); request.mockClear();
    useHQPlayerSettingsStore.setState({ spotifyExperiment: { ...defaults }, gainDb: -7, silentLaunch: false });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(HQPlayerSpotifyExperimentSettings))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('HQPlayer experiment controls', () => {
    it('shows the default-off checkbox, noise warning, scope and real units before enabling', () => {
        expect(checkbox().checked).toBe(false);
        expect(numbers().map(input => [input.disabled, input.value, input.min, input.max]))
            .toEqual([[true, '0', '0', '1000']]);
        expect(host.textContent).toContain('loud abnormal noise');
        expect(host.textContent).toContain('has not been confirmed as the cause');
        expect(host.textContent).toContain('app session');
        expect(host.textContent).toContain('next track load');
        expect(host.textContent).toContain('Pause/resume keeps this experimental delay');
        expect(host.textContent).toContain('turns off when the app restarts');
        expect(host.textContent).toContain('Prebuffer is shared with WASAPI and ASIO');
        expect(checkbox().getAttribute('aria-describedby')?.split(' ').every(id => host.querySelector(`[id="${id}"]`))).toBe(true);
        expect(request).not.toHaveBeenCalled();
    });
    it('requires an explicit click, commits timings on blur or Enter, and makes no playback requests', () => {
        act(() => checkbox().click());
        expect(numbers().every(input => !input.disabled)).toBe(true);
        edit(numbers()[0], '750');
        act(() => numbers()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(useHQPlayerSettingsStore.getState().spotifyExperiment).toEqual({ enabled: true, prebufferMs: 350, startupDelayMs: 750 });
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ prebufferMs: 350, startupDelayMs: 750 });
        act(() => checkbox().click());
        expect(numbers().every(input => input.disabled)).toBe(true);
        expect(useHQPlayerSettingsStore.getState().spotifyExperiment.enabled).toBe(false);
        expect(request).not.toHaveBeenCalled();
    });
    it('bounds malformed drafts and resets timings and opt-in without touching gain or launch preferences', () => {
        act(() => checkbox().click());
        edit(numbers()[0], '9000');
        act(() => numbers()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
        expect(numbers()[0].value).toBe('1000');
        edit(numbers()[0], '');
        act(() => numbers()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
        expect(numbers()[0].value).toBe('0');
        act(() => host.querySelector<HTMLButtonElement>('button')!.click());
        expect(checkbox().checked).toBe(false);
        expect(numbers().map(input => [input.value, input.disabled])).toEqual([['0', true]]);
        expect(useHQPlayerSettingsStore.getState()).toMatchObject({ spotifyExperiment: defaults, gainDb: -7, silentLaunch: false });
        expect(request).not.toHaveBeenCalled();
    });
});
