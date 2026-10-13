import { afterEach, expect, it, vi } from 'vitest';

// New profiles launch in the background; a listener's explicit foreground choice persists.
afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });
it('defaults to background launch when no preference has been saved', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const { useHQPlayerSettingsStore } = await import('../../../src/stores/useHQPlayerSettingsStore');
    expect(useHQPlayerSettingsStore.getState().silentLaunch).toBe(true);
    useHQPlayerSettingsStore.getState().setSilentLaunch(false);
    expect(storage.get('folia_hqplayer_silent_launch')).toBe('false');
    vi.resetModules();
    const reloaded = await import('../../../src/stores/useHQPlayerSettingsStore');
    expect(reloaded.useHQPlayerSettingsStore.getState().silentLaunch).toBe(false);
});
