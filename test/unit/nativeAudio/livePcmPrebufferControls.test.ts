// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LivePcmPrebufferSetting from '../../../src/components/audio/LivePcmPrebufferSetting';
import HQPlayerSpotifyExperimentSettings from '../../../src/components/audio/HQPlayerSpotifyExperimentSettings';
import { useAudioSettingsStore } from '../../../src/stores/useAudioSettingsStore';
import { useHQPlayerSettingsStore } from '../../../src/stores/useHQPlayerSettingsStore';
import { LIVE_PCM_PREBUFFER_KEY } from '../../../src/utils/livePcmPrebuffer';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS } from '../../../src/utils/hqplayerSpotifyExperiment';
import en from '../../../src/i18n/locales/en';

// Actual React controls/store: one slider, accessible units and zero playback/handoff side effects.
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => {} }, useTranslation: () => ({ t: (key: string) => {
    const [section, field] = key.split('.'); return (en as any)[section]?.[field] || key;
} }) }));
let host: HTMLDivElement, root: Root;
const request = vi.fn(), handoff = vi.fn();
vi.mock('../../../src/services/nativeAudio/outputHandoff', () => ({ prepareOutputHandoff: (...args: unknown[]) => handoff(...args) }));
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(window, { electron: { platform: 'win32', nativeAudio: { supported: true, request } } });
    localStorage.clear(); request.mockClear(); handoff.mockClear();
    useAudioSettingsStore.setState({ livePcmPrebufferMs: 350 });
    useHQPlayerSettingsStore.setState({ spotifyExperiment: { ...HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (disabled = false) => act(() => root.render(React.createElement(React.StrictMode, null,
    React.createElement(LivePcmPrebufferSetting, { disabled }), React.createElement(HQPlayerSpotifyExperimentSettings))));
it.each([25, 350, 1000])('shows and persists %i ms without playback controls or output handoff', value => {
    render(); const slider = host.querySelector<HTMLInputElement>('input[type=range]')!;
    expect([slider.min, slider.max, slider.step]).toEqual(['25', '1000', '1']);
    expect(host.querySelectorAll('input[type=range]')).toHaveLength(1);
    expect(host.querySelectorAll('input[type=number]')).toHaveLength(1); // Only the independent HQ startup delay remains.
    const revision = useAudioSettingsStore.getState().nativeAudioOutputRevision;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, String(value));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useAudioSettingsStore.getState().livePcmPrebufferMs).toBe(value);
    if (value !== 350) expect(localStorage.getItem(LIVE_PCM_PREBUFFER_KEY)).toBe(String(value));
    expect(host.querySelector('output')!.textContent).toBe(`${value} ms`);
    expect(slider.getAttribute('aria-valuetext')).toBe(`${value} ms`);
    expect(host.querySelector(`[id="${slider.getAttribute('aria-describedby')}"]`)!.textContent).toContain('dropouts');
    expect(host.querySelector(`label[for="${slider.id}"]`)!.textContent).toBe('Spotify PCM prebuffer');
    slider.focus(); expect(document.activeElement).toBe(slider);
    expect(slider.className).toContain('focus-visible:outline-2');
    expect(useAudioSettingsStore.getState().nativeAudioOutputRevision).toBe(revision);
    expect(request).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
});
it('has readable disabled styling and an independent experiment reset', () => {
    render(true); const slider = host.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(slider.disabled).toBe(true); expect(slider.className).toContain('disabled:opacity-60');
    act(() => useAudioSettingsStore.getState().handleSetLivePcmPrebufferMs(1000));
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(slider.value).toBe('1000'); expect(useHQPlayerSettingsStore.getState().spotifyExperiment.enabled).toBe(false);
    expect(request).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
});
