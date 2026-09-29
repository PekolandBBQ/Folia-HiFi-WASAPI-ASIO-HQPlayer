import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';
import type { HQPlayerDspSettings } from '../types/hqplayerDsp';

// src/stores/useHQPlayerSettingsStore.ts — fork-only HQPlayer gain preferences, independent of the native component.
export const clampHQPlayerGain = (value: number) => Math.round(Math.max(-120, Math.min(0, Number.isFinite(value) ? value : -2)) * 10) / 10;
const gainKey = 'folia_hqplayer_gain_db';
const rememberKey = 'folia_hqplayer_remember_gain';
const savedGain = typeof localStorage === 'undefined' ? null : localStorage.getItem(gainKey);
const defaultsKey = 'folia_hqplayer_dsp_defaults';
function readDefaults(): HQPlayerDspSettings | null {
    try {
        const value = JSON.parse(localStorage.getItem(defaultsKey) || 'null');
        return value && Number.isInteger(value.mode) && typeof value.filter === 'string'
            && typeof value.shaper === 'string' && Number.isFinite(value.rate) ? value : null;
    } catch { return null; }
}
export const useHQPlayerSettingsStore = create<{
    dspDefaults: HQPlayerDspSettings | null; setDspDefaults: (value: HQPlayerDspSettings | null) => void;
    silentLaunch: boolean; setSilentLaunch: (silent: boolean) => void;
    dspOpen: boolean; setDspOpen: (open: boolean) => void;
    gainDb: number; remember: boolean;
    setGain: (value: number) => void; setRemember: (value: boolean) => void;
}>(set => ({
    dspDefaults: readDefaults(),
    setDspDefaults: dspDefaults => { localStorage.setItem(defaultsKey, JSON.stringify(dspDefaults)); set({ dspDefaults }); },
    silentLaunch: getStoredBoolean('folia_hqplayer_silent_launch', false),
    setSilentLaunch: silentLaunch => { setStoredBoolean('folia_hqplayer_silent_launch', silentLaunch); set({ silentLaunch }); },
    dspOpen: false, setDspOpen: dspOpen => set({ dspOpen }),
    gainDb: savedGain === null ? -2 : clampHQPlayerGain(Number(savedGain)),
    remember: getStoredBoolean(rememberKey, false),
    setGain: value => { const gainDb = clampHQPlayerGain(value); localStorage.setItem(gainKey, String(gainDb)); set({ gainDb }); },
    setRemember: remember => { setStoredBoolean(rememberKey, remember); set({ remember }); },
}));
