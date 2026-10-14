import { test, expect } from './fixtures';

// Only the IPC edge is mocked; the production provider, setup controller and connection guide are used.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('active_online_provider_id', 'spotify');
        let authenticated = false;
        let setup = { hasKey: false, state: 'unconfigured' };
        Object.assign(window, { spotifyConnectionProbe: { operations: [], ready: () => { setup = { hasKey: true, state: 'ready' }; } } });
        Object.assign(window, { spotifySavedOffsets: [], electron: { spotify: { request: async (input: { action: string; operation?: string; offset?: number; limit?: number }) => {
            (window as any).spotifyConnectionProbe.operations.push(input.operation || input.action);
            if (input.action === 'playbackSetup') {
                if (input.operation === 'saveKey') setup = { hasKey: true, state: 'stopped' };
                if (input.operation === 'start') setup = { hasKey: true, state: 'pairing-required' };
                return { ...setup };
            }
            if (input.action === 'status') return authenticated ? { id: 'test-account', display_name: 'Spotify user', product: 'premium' } : null;
            if (input.action === 'loginBegin') return 'test-key';
            if (input.action === 'loginImage') return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/></svg>');
            if (input.action === 'loginCheck') { authenticated = true; return { state: 'confirmed' }; }
            if (input.action === 'loginCancel') return null;
            if (input.action === 'logout') { authenticated = false; return null; }
            if (input.action === 'playlists') return { items: [{ id: '0123456789012345678901', name: 'My Spotify playlist', type: 'playlist', items: { total: 5 } }], total: 1, next: null };
            if (input.action === 'savedTracks') {
                const offset = input.offset || 0, limit = input.limit || 50;
                (window as any).spotifySavedOffsets.push(offset);
                return { items: Array.from({ length: Math.min(limit, 60 - offset) }, (_, index) => ({
                    track: { id: String(offset + index).padStart(22, '0'), name: `Saved ${offset + index}`, type: 'track' },
                })), total: 60, next: offset + limit < 60 ? 'next' : null };
            }
            throw new Error('Unexpected Spotify test operation');
        } } } });
    });
});
test('requires the guided key, receiver and same-computer pairing before completing connection', async ({ page, mount }) => {
    await mount('spotifyAccount');
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Connect Spotify' })).toBeVisible();
    await expect(page.getByText('Continue in your browser')).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR Code' })).toHaveCount(0);
    await expect(page.getByLabel('Personal Soloist key')).toBeVisible();
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    await expect(page.getByRole('button', { name: 'Finish connection', exact: true })).toHaveCount(0);
    const key = 'spak_' + 'A'.repeat(32);
    await page.getByLabel('Personal Soloist key').fill(key);
    await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(page.getByLabel('Personal Soloist key')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key);
    await page.getByRole('button', { name: 'Download and connect', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-pairing')).toContainText('same computer');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => (window as any).spotifyConnectionProbe.ready());
    await page.getByRole('button', { name: 'Finish connection', exact: true }).click();
    await expect(page.getByTestId('account-state')).toHaveText('authenticated');
    await expect(page.getByText('My Spotify playlist')).toBeVisible();
    await expect(page.getByText('Liked Songs', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).spotifySavedOffsets)).toEqual([0, 50]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    await expect(page.getByText('My Spotify playlist')).toHaveCount(0);
    await expect(page.getByText('Liked Songs', { exact: true })).toHaveCount(0);
});
test('closing pairing retains the anonymous state', async ({ page, mount }) => {
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
});

test('an unreadable session clears the visible account without deleting the stored grant', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const request = window.electron!.spotify!.request;
        Object.assign(window, { spotifyLogoutCalls: 0 });
        window.electron!.spotify!.request = async input => {
            if (input.action === 'logout') (window as any).spotifyLogoutCalls++;
            if (input.action === 'status') return { spotifyError: { code: 'auth-required', message: 'Spotify: session-unreadable' } };
            return request(input);
        };
    });
    await mount('spotifyAccount');
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    expect(await page.evaluate(() => (window as any).spotifyLogoutCalls)).toBe(0);
});
for (const daylight of [false, true]) test(`Spotify pairing has the shared glass surface (${daylight ? 'light' : 'dark'})`, async ({ page, mount }) => {
    await page.addInitScript(daylight => {
        localStorage.setItem('default_theme_daylight', String(daylight));
        const request = window.electron!.spotify!.request;
        window.electron!.spotify!.request = async input => input.action === 'loginCheck' ? { state: 'waiting' } : request(input);
    }, daylight);
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Spotify' });
    await expect(dialog).toBeVisible();
    const surface = dialog.locator(':scope > div');
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(surface).toHaveCSS('opacity', '1');
    await expect(surface).toHaveCSS('backdrop-filter', 'blur(40px)');
    await expect(surface).toHaveClass(daylight ? /bg-white\/60/ : /bg-white\/10/);
    await page.screenshot({ path: `test-results/spotify-${daylight ? 'light' : 'dark'}.png` });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
});


test('reopens a stopped configured account without reauthorization or key replacement', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const request = window.electron!.spotify!.request;
        window.electron!.spotify!.request = async input => {
            if (input.action === 'status') return { id: 'test-account', display_name: 'Spotify user', product: 'premium' };
            if (input.action === 'playbackSetup' && input.operation === 'status') return { hasKey: true, state: 'stopped' };
            return request(input);
        };
    });
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-receiver')).toBeVisible();
    await expect(page.getByLabel('Personal Soloist key')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-key')).toContainText('already encrypted');
    await expect(page.getByLabel('Personal Soloist key')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-receiver')).toBeVisible();
    expect(await page.evaluate(() => (window as any).spotifyConnectionProbe.operations)).not.toContain('loginBegin');
});

test('unfinished connection resumes from live receiver status after app restart', async ({ page, mount }) => {
    await page.addInitScript(() => {
        localStorage.setItem('spotify_connection_pending', 'true');
        const request = window.electron!.spotify!.request;
        window.electron!.spotify!.request = async input => {
            if (input.action === 'status') return { id: 'test-account', display_name: 'Spotify user', product: 'premium' };
            if (input.action === 'playbackSetup' && input.operation === 'status') return { hasKey: true, state: 'pairing-required' };
            return request(input);
        };
    });
    await mount('spotifyAccount');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('spotify-connect-pairing')).toBeVisible();
    await expect(page.getByLabel('Personal Soloist key')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('spotify_connection_pending'))).toBe('true');
});
