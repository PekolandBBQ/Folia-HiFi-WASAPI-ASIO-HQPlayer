import { test, expect } from './fixtures';

// Exercises the production form and Omni facade; only the Electron transport is replaced.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        let settings = { mode: 'custom', clientId: 'a'.repeat(32), redirectUri: 'http://127.0.0.1:43821/callback', readOnly: false };
        Object.assign(window, { spotifySaved: [], electron: { spotify: { request: async (input: any) => {
            if (input.action === 'configuration') return settings;
            if (input.action === 'playbackSetup' && input.operation === 'status') return { hasKey: false, state: 'unconfigured' };
            if (input.action === 'configure') {
                if (!/^[a-f0-9]{32}$/.test(input.settings.clientId)) return { spotifyError: { code: 'invalid-response', message: 'Spotify: invalid-client-id' } };
                (window as any).spotifySaved.push(input.settings); settings = input.settings;
                return { settings, changed: true };
            }
            throw new Error('Unexpected operation');
        } } } });
    });
});
test('loads, edits and saves through the shared settings UI without a client secret', async ({ page, mount }) => {
    await mount('spotifySettings');
    await expect(page.getByLabel('Spotify Client ID')).toHaveValue('a'.repeat(32));
    await expect(page.getByText(/If you use a Spotify Development Mode app/)).toBeVisible();
    await page.getByLabel('Spotify Client ID').fill('b'.repeat(32));
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Spotify connection', exact: true })).toContainText('Connection saved');
    expect(await page.evaluate(() => (window as any).spotifySaved)).toEqual([{ mode: 'custom', clientId: 'b'.repeat(32), redirectUri: 'http://127.0.0.1:43821/callback', readOnly: false }]);
    await expect(page.locator('select')).toHaveCount(0);
    await expect(page.getByLabel('Personal Soloist key')).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Authorization client' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('option', { name: 'Shared client (ncspot)' }).click();
    await expect(page.getByLabel('Spotify Client ID')).toHaveCount(0);
});
test('failed edits remain visible and can be corrected', async ({ page, mount }) => {
    await mount('spotifySettings');
    await page.getByLabel('Spotify Client ID').fill('invalid');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Spotify connection', exact: true })).toContainText('Unable to save');
    await expect(page.getByLabel('Spotify Client ID')).toHaveValue('invalid');
    await page.getByLabel('Spotify Client ID').fill('c'.repeat(32));
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Spotify connection', exact: true })).toContainText('Connection saved');
});
test('environment-managed settings cannot be edited', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const original = window.electron!.spotify!.request;
        window.electron!.spotify!.request = async input => {
            const result: any = await original(input);
            return input.action === 'configuration' ? { ...result, readOnly: true } : result;
        };
    });
    await mount('spotifySettings');
    await expect(page.getByLabel('Spotify Client ID')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
    await expect(page.getByText('These values are managed by the launch environment.')).toBeVisible();
});
for (const daylight of [false, true]) test(`uses the shared settings controls in ${daylight ? 'light' : 'dark'} mode`, async ({ page, mount }) => {
    await page.addInitScript(daylight => localStorage.setItem('default_theme_daylight', String(daylight)), daylight);
    await mount('spotifySettings');
    await expect(page.getByLabel('Spotify Client ID')).toBeVisible();
    await page.getByRole('button', { name: 'Authorization client' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('listbox')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: `test-results/spotify-settings-${daylight ? 'light' : 'dark'}.png` });
    await expect(page.locator('select, input[type="checkbox"], input[type="radio"]')).toHaveCount(0);
});

test('encrypt-key setup clears its input, reports measured download progress and fences a late start after stop', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const bridge = window.electron!.spotify!, original = bridge.request;
        let status = { hasKey: false, state: 'unconfigured' };
        const listeners = new Set<(value: any) => void>();
        let complete: ((value: any) => void) | undefined, activeRequest: string | undefined;
        (window as any).setupProbe = { operations: [],
            progress: () => listeners.forEach(callback => callback({ requestId: activeRequest, stage: 'download', loaded: 3, total: 10 })),
            complete: () => complete?.({ hasKey: true, state: 'ready' }) };
        bridge.onProgress = callback => { listeners.add(callback); return () => listeners.delete(callback); };
        bridge.request = async input => {
            if (input.action !== 'playbackSetup') return original(input);
            (window as any).setupProbe.operations.push(input.operation);
            if (input.operation === 'status') return { ...status };
            if (input.operation === 'saveKey') { status = { hasKey: true, state: 'stopped' }; return { ...status }; }
            if (input.operation === 'stop') { status = { hasKey: true, state: 'stopped' }; return { ...status }; }
            if (input.operation === 'start') { activeRequest = input.requestId; return new Promise(resolve => { complete = resolve; }); }
            throw new Error('Unexpected setup action');
        };
    });
    await mount('spotifySettings');
    const setup = page.getByTestId('spotify-playback-setup'), key = 'spak_' + 'A'.repeat(32);
    await expect(setup).toContainText('Personal key not configured');
    await page.getByLabel('Personal Soloist key').fill(key);
    await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(page.getByLabel('Personal Soloist key')).toHaveValue('');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key);
    await page.getByRole('button', { name: 'Download and connect', exact: true }).click();
    await expect(setup).toContainText('Preparing playback connection');
    await page.evaluate(() => (window as any).setupProbe.progress());
    await expect(setup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    await expect(page.getByRole('button', { name: 'Stop connection', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop connection', exact: true }).click();
    await expect(setup).toContainText('Connection stopped');
    await page.evaluate(() => (window as any).setupProbe.complete());
    await expect(page.getByRole('button', { name: 'Download and connect', exact: true })).toBeEnabled();
    await expect(setup).not.toContainText('Playback connection ready');
    await expect(setup.getByRole('progressbar')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).setupProbe.operations.filter((value: string) => value !== 'status'))).toEqual(['saveKey', 'start', 'stop']);
});

test('a first pairing status refresh becomes ready without reopening settings', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const bridge = window.electron!.spotify!, original = bridge.request;
        let reads = 0;
        bridge.request = async input => input.action === 'playbackSetup' && input.operation === 'status'
            ? { hasKey: true, state: ++reads > 2 ? 'ready' : 'pairing-required' } : original(input);
    });
    await mount('spotifySettings');
    const setup = page.getByTestId('spotify-playback-setup');
    await expect(setup).toContainText('Waiting for the official app to connect');
    await expect(setup).toContainText('select Folia Spotify');
    await expect(setup).toContainText('Playback connection ready', { timeout: 5000 });
    await expect(setup).not.toContainText('select Folia Spotify');
});
