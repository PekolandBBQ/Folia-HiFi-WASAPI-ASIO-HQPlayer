import { test, expect } from './fixtures';

// test/component/spotifyOutputSetup.spec.ts: real guide/controller with a synthetic native setup boundary; no Spotify or Windows I/O.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('active_online_provider_id', 'spotify');
        let selection = { connectDeviceId: '', captureDeviceId: '', renderDeviceId: '',
            internal44100Confirmed: false, spotifyOnlyConfirmed: false, defaultsConfirmed: false };
        const probe = { operations: [] as string[], savedSelection: () => ({ ...selection }),
            saved: (client = false) => { selection = { connectDeviceId: 'desktop-1', captureDeviceId: 'capture-1', renderDeviceId: 'render-1',
                internal44100Confirmed: true, spotifyOnlyConfirmed: client, defaultsConfirmed: false }; } };
        Object.assign(window, { spotifyOutputProbe: probe });
        Object.assign(window, { electron: { spotify: { request: async (input: { action: string; operation?: string; selection?: typeof selection }) => {
            probe.operations.push(input.operation || input.action);
            if (input.action === 'status') return { id: 'test-account', display_name: 'Spotify user', product: 'premium' };
            if (input.action === 'playbackSetup') {
                if (input.operation === 'saveSelection') selection = { ...input.selection! };
                const complete = Boolean(selection.connectDeviceId && selection.captureDeviceId && selection.renderDeviceId
                    && selection.internal44100Confirmed && selection.spotifyOnlyConfirmed);
                return { backend: 'vb-cable', state: complete ? 'stopped' : 'routing-required',
                    code: complete ? 'AUTOMATIC_ROUTE_ON_PLAY' : 'SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED',
                    driverInstalled: true, driverBundled: true, driverInstallerAvailable: true, spotifyRunning: true,
                    automaticRoute: { enabled: true, supported: false, productionQualified: false, eligible: complete,
                        sourceOutputDefaultRequired: false, trialAvailable: true, trialAuthorized: false }, selection: { ...selection },
                    devices: { spotify: [{ id: 'desktop-1', name: 'Desktop', type: 'computer', isActive: false, restricted: false, selectable: true }],
                        capture: [{ id: 'capture-1', name: 'CABLE Output' }], render: [{ id: 'render-1', name: 'CABLE Input' }] } };
            }
            if (input.action === 'playlists') return { items: [{ id: '0123456789012345678901', name: 'My Spotify playlist', type: 'playlist', items: { total: 1 } }], total: 1, next: null };
            if (input.action === 'savedTracks') return { items: [], total: 0, next: null };
            if (input.action === 'loginCancel' || input.action === 'logout') return null;
            throw new Error(`Unexpected synthetic Spotify operation: ${input.action}`);
        } } } });
    });
});

test('completes required first setup and enters the library without a mode choice or separate verification', async ({ page, mount }) => {
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await page.getByLabel('Spotify Connect device', { exact: true }).selectOption('desktop-1');
    await page.getByRole('button', { name: 'Save choices', exact: true }).click();
    const cable = page.getByTestId('spotify-connect-cable');
    await expect(cable).toBeVisible();
    await page.getByLabel('Spotify output: CABLE Input', { exact: true }).selectOption('render-1');
    await page.getByLabel('Folia input: CABLE Output', { exact: true }).selectOption('capture-1');
    await expect(cable.getByText('In the Spotify desktop client, open Settings → Playback → Audio output and choose Default.', { exact: true })).toBeVisible();
    await expect(cable.getByText(/If Spotify shows an exclusive-mode option/)).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Finish connection', exact: true })).toHaveCount(0);
    await page.getByRole('checkbox', { name: /I set Audio output to Default in the Spotify client/ }).check();
    await page.getByRole('button', { name: 'Save choices', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Finish connection', exact: true })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'I set VB-CABLE Internal Sampling Rate to 44100 Hz.', exact: true }).check();
    await page.getByRole('button', { name: 'Save choices', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-ready')).toContainText('Open a playlist and click a track');
    await page.getByRole('button', { name: 'Finish connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('My Spotify playlist', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).spotifyOutputProbe.operations.some((value: string) => ['probe', 'start', 'openDriver'].includes(value)))).toBe(false);
    const selection = await page.evaluate(() => (window as any).spotifyOutputProbe.savedSelection());
    expect(selection).toMatchObject({ internal44100Confirmed: true, spotifyOnlyConfirmed: true, defaultsConfirmed: false });
    expect(selection).not.toHaveProperty('automaticRouteTrialEnabled');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-ready')).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
});

for (const daylight of [false, true]) test(`migration confirmation stays usable in a compact ${daylight ? 'light' : 'dark'} viewport`, async ({ page, mount }) => {
    await page.setViewportSize({ width: 720, height: 540 });
    await page.addInitScript(daylight => localStorage.setItem('default_theme_daylight', String(daylight)), daylight);
    await mount('spotifyAccount');
    await page.evaluate(() => (window as any).spotifyOutputProbe.saved(false));
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Spotify' });
    const client = page.getByRole('checkbox', { name: /I set Audio output to Default in the Spotify client/ });
    const internal = page.getByRole('checkbox', { name: 'I set VB-CABLE Internal Sampling Rate to 44100 Hz.', exact: true });
    await expect(client).not.toBeChecked(); await expect(internal).toBeChecked();
    await client.scrollIntoViewIfNeeded();
    await expect(client).toBeVisible();
    const box = await dialog.locator('.spotify-connection-panel').boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(15); expect(box!.y + box!.height).toBeLessThanOrEqual(525);
    const scroll = dialog.getByTestId('spotify-connection-scroll-content');
    expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/spotify-r19-client-setup-${daylight ? 'light' : 'dark'}.png` });
    await client.check();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(client).not.toBeChecked();
    await client.check();
    await page.getByRole('button', { name: 'Save choices', exact: true }).click();
    await expect(page.getByTestId('spotify-connect-ready')).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(client).toBeChecked(); await expect(internal).toBeChecked();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Finish connection', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).spotifyOutputProbe.operations.filter((value: string) => value === 'saveSelection'))).toHaveLength(1);
});
