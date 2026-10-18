// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cableStatus } from './spotifyCableFixture';
import type { SpotifyConnection } from '@/hooks/useSpotifyConnection';
import type { ProviderPlaybackSetupStatus } from '@/types/onlineMusic';

// Offline SSR checks cover native labels, disabled options and selection state; no audio operations run.
const fixture = vi.hoisted(() => ({ state: { status: null as ProviderPlaybackSetupStatus | null, busy: false }, run: vi.fn() }));
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useSpotifyPlaybackSetup', () => ({ useSpotifyPlaybackSetup: () => fixture.state }));
vi.mock('@/services/onlineMusic/spotifyPlaybackSetup', () => ({ spotifyPlaybackSetup: {
    canRun: () => true, run: fixture.run,
} }));
import SpotifyCableFields from '@/components/modal/settings/SpotifyCableFields';
import { SpotifyConnectionDialog as SpotifyConnectionModal } from '@/components/app/home/SpotifyConnectionModal';
import { PLAYER_PROGRESS_FRAME_CLASS, playerProgressGlass } from '@/components/floating-player/playerProgressAppearance';

beforeEach(() => {
    fixture.state = { busy: false, status: cableStatus({ devices: {
        spotify: [
            { id: 'desktop-1', name: 'Spotify Desktop', type: 'computer', isActive: true, restricted: false, selectable: true },
            { id: 'phone-1', name: 'Unavailable phone', type: 'smartphone', isActive: false, restricted: true, selectable: false },
        ],
        capture: [{ id: 'capture-1', name: 'CABLE Output (VB-Audio Virtual Cable)' }],
        render: [
            { id: 'render-1', name: 'Speakers (VB-Audio Virtual Cable)' },
            { id: 'render-2', name: 'CABLE In 16Ch (VB-Audio Virtual Cable)' },
        ],
    } }) };
    fixture.run.mockClear();
});
const render = (section: 'all' | 'desktop' | 'cable') => {
    const html = renderToStaticMarkup(React.createElement(SpotifyCableFields, { section }));
    const host = document.createElement('div'); host.innerHTML = html;
    return { html, host, selects: Array.from(host.querySelectorAll('select')) };
};
describe('native cable dropdown SSR contract', () => {
    it.each([['all', 3], ['desktop', 1], ['cable', 2]] as const)('covers every native dropdown in %s', (section, count) => {
        const { selects, host } = render(section);
        expect(selects).toHaveLength(count);
        for (const select of selects) {
            expect(select.classList.contains('spotify-cable-select')).toBe(true);
            expect(select.getAttribute('aria-label')).toMatch(/^spotifyCable\./);
            expect(select.options[0].value).toBe('');
            expect(select.options[0].text).toBe('spotifyCable.select');
            expect(select.disabled).toBe(false);
        }
        expect(host.querySelectorAll('option[value="phone-1"]:disabled')).toHaveLength(section === 'cable' ? 0 : 1);
        expect(fixture.run).not.toHaveBeenCalled();
    });
    it('keeps both render labels visible in markup before selection and marks only saved IDs selected', () => {
        fixture.state.status!.selection!.connectDeviceId = '';
        fixture.state.status!.selection!.renderDeviceId = '';
        fixture.state.status!.selection!.captureDeviceId = '';
        const blank = render('all');
        expect(blank.selects.map(select => select.value)).toEqual(['', '', '']);
        expect(blank.host.textContent).toContain('Speakers (VB-Audio Virtual Cable)');
        expect(blank.host.textContent).toContain('CABLE In 16Ch (VB-Audio Virtual Cable)');
        fixture.state.status!.selection!.renderDeviceId = 'render-2';
        const selected = render('all');
        expect(selected.selects.map(select => select.value)).toEqual(['', 'render-2', '']);
        expect(selected.host.querySelectorAll('option[selected]')).toHaveLength(3);
        saveArtifact('cable-selects-empty.ssr.html', blank.html);
        saveArtifact('cable-selects-selected.ssr.html', selected.html);
        expect(fixture.run).not.toHaveBeenCalled();
    });
    it('keeps every dropdown disabled while setup is busy', () => {
        fixture.state.busy = true;
        expect(render('all').selects.every(select => select.disabled)).toBe(true);
        expect(fixture.run).not.toHaveBeenCalled();
    });
});

const saveArtifact = (filename: string, html: string) => {
    const destination = process.env.FOLIA_SSR_ARTIFACT_DIR;
    if (!destination) return;
    mkdirSync(destination, { recursive: true });
    writeFileSync(`${destination}/${filename}`, html);
};
describe('Spotify wizard SSR presentation', () => {
    it.each([false, true])('reuses the player glass surface and native color scheme, daylight=%s', daylight => {
        for (const step of ['catalog', 'desktop', 'cable', 'ready'] as const) {
            const connection = { step, setup: fixture.state, login: { qrState: 'idle' }, checking: false, error: null } as unknown as SpotifyConnection;
            const html = renderToStaticMarkup(React.createElement(SpotifyConnectionModal, { connection, daylight }));
            const host = document.createElement('div'); host.innerHTML = html;
            const panel = host.querySelector<HTMLElement>('.spotify-connection-panel')!;
            for (const name of `${PLAYER_PROGRESS_FRAME_CLASS} ${playerProgressGlass(daylight, true)}`.split(' '))
                expect(panel.classList.contains(name)).toBe(true);
            expect(panel.style.colorScheme).toBe(daylight ? 'light' : 'dark');
            expect(panel.classList.contains('bg-white/10')).toBe(false);
            expect(host.querySelector('[role=dialog]')?.getAttribute('aria-modal')).toBe('true');
            expect(host.querySelector(`[data-testid="spotify-connect-${step}"]`)).not.toBeNull();
            expect(host.querySelectorAll('select')).toHaveLength(step === 'desktop' ? 1 : step === 'cable' ? 2 : 0);
            expect(host.querySelectorAll('button')).not.toHaveLength(0);
            expect(fixture.run).not.toHaveBeenCalled();
            saveArtifact(`wizard-${daylight ? 'light' : 'dark'}-${step}.ssr.html`, html);
        }
    });
    it('preserves the failed inspection alert and retry without exposing the setup step', () => {
        const connection = { step: 'cable', setup: fixture.state, login: { qrState: 'idle' }, checking: false, error: 'readFailed' } as unknown as SpotifyConnection;
        const html = renderToStaticMarkup(React.createElement(SpotifyConnectionModal, { connection, daylight: false }));
        const host = document.createElement('div'); host.innerHTML = html;
        expect(host.querySelector('[role=alert]')?.textContent).toBe('spotifyConnection.readFailed');
        expect(host.textContent).toContain('spotifyConnection.checkAgain');
        expect(host.querySelector('[data-testid=spotify-connect-cable]')).toBeNull();
        expect(host.querySelector('[aria-current=step]')).toBeNull();
        expect(fixture.run).not.toHaveBeenCalled();
        saveArtifact('wizard-dark-error.ssr.html', html);
    });
});
