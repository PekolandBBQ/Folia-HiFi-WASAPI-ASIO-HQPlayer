import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useHQPlayerSettingsStore.ts — fork-only HQPlayer gain preferences, independent of the native component.
export const clampHQPlayerGain = (value: number) => Math.round(Math.max(-120, Math.min(0, Number.isFinite(value) ? value : -2)) * 10) / 10;
const gainKey = 'folia_hqplayer_gain_db';
const rememberKey = 'folia_hqplayer_remember_gain';
const savedGain = typeof localStorage === 'undefined' ? null : localStorage.getItem(gainKey);
export const useHQPlayerSettingsStore = create<{
    gainDb: number; remember: boolean;
    setGain: (value: number) => void; setRemember: (value: boolean) => void;
}>(set => ({
    gainDb: savedGain === null ? -2 : clampHQPlayerGain(Number(savedGain)),
    remember: getStoredBoolean(rememberKey, false),
    setGain: value => { const gainDb = clampHQPlayerGain(value); localStorage.setItem(gainKey, String(gainDb)); set({ gainDb }); },
    setRemember: remember => { setStoredBoolean(rememberKey, remember); set({ remember }); },
}));
