import { expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { OnlineProviderError } from '@/types/onlineMusic';
import { createOnlinePlaybackFailureStatus } from '@/components/app/playback/onlinePlaybackFailure';

// A retained source recovery failure must use fixed copy and an explicit connection action.
vi.mock('@/stores/useSettingsModalStore', () => ({ openSettings: vi.fn() }));
const translate = ((key: string) => key) as TFunction;

it('surfaces an unconfirmed source restore separately from generic playback failures', () => {
    const status = createOnlinePlaybackFailureStatus(new OnlineProviderError('unavailable',
        'Spotify: automatic-route-restore-unconfirmed', 'spotify'), translate);
    expect(status).toMatchObject({ type: 'error', persistent: true,
        text: 'spotifyCable.sourceRestoreUnconfirmed', actionLabel: 'spotifyPlaybackErrors.openConnection' });
    expect(status.onAction).toEqual(expect.any(Function));
    expect(status).not.toHaveProperty('statusKey');
});

it('keeps unknown provider details out of the renderer message', () => {
    const status = createOnlinePlaybackFailureStatus(new OnlineProviderError('unavailable',
        'Spotify: private-token-source-restore-unconfirmed', 'spotify'), translate);
    expect(status.text).toBe('spotifyPlaybackErrors.unavailable');
    expect(status.persistent).toBeUndefined();
    expect(status.text).not.toContain('private');
});

it('keeps structured Spotify component reasons visible on the playback page', () => {
 const error = new OnlineProviderError('unavailable', 'Spotify: cable-preparation-failed', 'spotify', undefined, undefined, undefined, { userMessage: '采集程序无法启动 [CAPTURE_HELPER_UNAVAILABLE]', nativeCode: 'CAPTURE_HELPER_UNAVAILABLE' });
 expect(createOnlinePlaybackFailureStatus(error, translate).text).toBe('采集程序无法启动 [CAPTURE_HELPER_UNAVAILABLE]');
});
