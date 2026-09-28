import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withHQPlayer } from '../../../src/services/nativeAudio/hqplayerSettings';

// test/unit/nativeAudio/hqplayerSettings.test.ts — unavailable components must never commit settings or pause playback.
const mocks = vi.hoisted(() => ({ notify: vi.fn(), open: vi.fn(), request: vi.fn() }));
vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../src/stores/useStatusMessageStore', () => ({ setStatusMessage: mocks.notify }));
vi.mock('../../../src/stores/useSettingsModalStore', () => ({ useSettingsModalStore: { getState: () => ({ openSettings: mocks.open }) } }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', { electron: { platform: 'win32', nativeAudio: { supported: true, request: mocks.request } } }); });
afterEach(() => vi.unstubAllGlobals());

it('blocks changes and opens the installation settings from a command', async () => {
    mocks.request.mockResolvedValue({ available: false, installed: false });
    const change = vi.fn();
    expect(await withHQPlayer(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith('options', 'playback', null, 'hqPlayerOutput');
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ text: 'nativeAudio.errors.HQPLAYER_UNAVAILABLE' }));
});
it('allows the same action after installation without retaining stale availability', async () => {
    mocks.request.mockResolvedValueOnce({ available: false }).mockResolvedValueOnce({ available: true });
    const change = vi.fn();
    await withHQPlayer(change);
    await withHQPlayer(change);
    expect(change).toHaveBeenCalledTimes(1);
});
it('handles an absent bridge without changing settings', async () => {
    vi.stubGlobal('window', {});
    const change = vi.fn();
    expect(await withHQPlayer(change)).toBe(false);
    expect(change).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it('shows only a translated fixed code if checking status fails', async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error('private diagnostic'), { code: 'COMPONENT_INTEGRITY' }));
    const change = vi.fn();
    await withHQPlayer(change);
    expect(change).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ text: 'nativeAudio.errors.COMPONENT_INTEGRITY' }));
});
