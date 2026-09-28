import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withNativeAudioComponent } from '../../../src/services/nativeAudio/settingsGate';

// test/unit/nativeAudio/settingsGate.test.ts — unavailable components must never commit settings or pause playback.
const mocks = vi.hoisted(() => ({ notify: vi.fn(), open: vi.fn(), request: vi.fn() }));
vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../src/stores/useStatusMessageStore', () => ({ setStatusMessage: mocks.notify }));
vi.mock('../../../src/stores/useSettingsModalStore', () => ({ useSettingsModalStore: { getState: () => ({ openSettings: mocks.open }) } }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', { electron: { platform: 'win32', nativeAudio: { supported: true, request: mocks.request } } }); });
afterEach(() => vi.unstubAllGlobals());

it('blocks changes and opens the installation settings from a command', async () => {
    mocks.request.mockResolvedValue({ available: false, installed: false });
    const change = vi.fn();
    expect(await withNativeAudioComponent(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith('options', 'playback', null, 'nativeAudioOutput');
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ text: 'nativeAudio.errors.COMPONENT_UNAVAILABLE' }));
});
it('allows the same action after installation without retaining stale availability', async () => {
    mocks.request.mockResolvedValueOnce({ available: false }).mockResolvedValueOnce({ available: true });
    const change = vi.fn();
    await withNativeAudioComponent(change);
    await withNativeAudioComponent(change);
    expect(change).toHaveBeenCalledTimes(1);
});
it('uses the settings dialog callback without also emitting a second prompt', async () => {
    const status = { available: false, installed: true, errorCode: 'COMPONENT_INCOMPATIBLE' };
    mocks.request.mockResolvedValue(status);
    const change = vi.fn(), prompt = vi.fn();
    await withNativeAudioComponent(change, prompt);
    expect(prompt).toHaveBeenCalledWith(status);
    expect(change).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
});
it('handles an absent bridge without changing settings', async () => {
    vi.stubGlobal('window', {});
    const change = vi.fn();
    expect(await withNativeAudioComponent(change)).toBe(false);
    expect(change).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it('shows only a translated fixed code if checking status fails', async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error('private diagnostic'), { code: 'COMPONENT_INTEGRITY' }));
    const change = vi.fn();
    await withNativeAudioComponent(change);
    expect(change).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ text: 'nativeAudio.errors.COMPONENT_INTEGRITY' }));
});
