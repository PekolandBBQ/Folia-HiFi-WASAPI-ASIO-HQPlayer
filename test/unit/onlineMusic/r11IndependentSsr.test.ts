import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpotifyConnection } from '@/hooks/useSpotifyConnection';

// Independent genuine Node SSR: there is no document/window and no production provider I/O.
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
const mock = vi.hoisted(() => ({ state: { status: null, busy: false }, run: vi.fn() }));
vi.mock('@/hooks/useSpotifyPlaybackSetup', () => ({ useSpotifyPlaybackSetup: () => mock.state }));
vi.mock('@/services/onlineMusic/spotifyPlaybackSetup', () => ({ spotifyPlaybackSetup: { canRun: () => false, run: mock.run } }));
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';

describe('independent true Node SSR modal', () => {
    it.each(['catalog', 'desktop', 'cable', 'ready'] as const)('renders actual default component at %s without DOM or effects', step => {
        expect(typeof document).toBe('undefined');
        const connection = { step, checking: false, error: null, finishing: false, setup: mock.state, login: { qrState: 'idle' }, catalogAuthorized: step !== 'catalog' } as unknown as SpotifyConnection;
        const html = renderToStaticMarkup(React.createElement(SpotifyConnectionModal, { connection, daylight: true }));
        expect(html).toContain('role="dialog"');
        expect(html).toContain('data-folia-keyboard-window="true"');
        expect(html).toContain(`data-testid="spotify-connect-${step}"`);
        expect(html.indexOf('<header')).toBeLessThan(html.indexOf('spotify-connection-content'));
        if (step === 'catalog') expect(html).not.toContain('<footer');
        else expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('spotify-connection-content'));
        expect(mock.run).not.toHaveBeenCalled();
    });
});
