import { test, expect } from './fixtures';
import { automaticCableStatus } from '../unit/onlineMusic/spotifyCableFixture';

// Production Wrapper guide/library controller, synthetic IPC only. Not an installation or playback claim.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(cable => {
        localStorage.setItem('active_online_provider_id', 'spotify');
        let authenticated = false;
        let status = {
            enabled: true, installations: [{ id: 'desktop-1', layout: 'desktop', version: 'fixture' }], selected: 'desktop-1',
            detectionFailed: false, running: false, connected: false, cli: false, wrapper: false, extension: false,
            driver: false, driverEndpointsReady: false, engine: false, ready: false, bundleVersion: 'preview.3',
            versions: { spicetify: '2.45.3', cable: '45' }, systemOutput: { state: 'ready', names: ['Fixture speakers'] },
            install: { phase: 'idle', busy: false, restartRequired: false },
        };
        Object.assign(window, { spotifyConnectionProbe: {
            operations: [] as string[], patch: (patch: typeof status) => { status = { ...status, ...patch }; },
            authenticate: () => { authenticated = true; },
        }, spotifySavedOffsets: [] as number[] });
        Object.assign(window, { electron: { spotify: { request: async (input: any) => {
            (window as any).spotifyConnectionProbe.operations.push(`${input.action}:${input.operation || ''}`);
            if (input.action === 'desktopSetup') {
                if (input.operation === 'install') status = { ...status, cli: true, driver: true, driverEndpointsReady: true, engine: true, install: { ...status.install, phase: 'installed' } };
                if (input.operation === 'configure') status = { ...status, wrapper: true, extension: true, install: { ...status.install, phase: 'complete' } };
                if (input.operation === 'launch') { authenticated = true; status = { ...status, running: true, connected: true, ready: true }; }
                return status;
            }
            if (input.action === 'playbackSetup') return cable;
            if (input.action === 'status') return authenticated ? { id: 'test-account', display_name: 'Spotify user', product: 'premium' } : null;
            if (input.action === 'logout') { authenticated = false; return null; }
            if (input.action === 'playlists') return { items: [{ id: '0123456789012345678901', name: 'My Spotify playlist', type: 'playlist', items: { total: 5 } }], total: 1, next: null };
            if (input.action === 'savedTracks') {
                const offset = input.offset || 0, limit = input.limit || 50;
                (window as any).spotifySavedOffsets.push(offset);
                return { items: Array.from({ length: Math.max(0, Math.min(limit, 60 - offset)) }, (_, index) => ({
                    track: { id: String(offset + index).padStart(22, '0'), name: `Saved ${offset + index}`, type: 'track' },
                })), total: 60, next: offset + limit < 60 ? 'next' : null };
            }
            throw new Error(`Unexpected Spotify test operation: ${input.action}`);
        } } } });
    }, automaticCableStatus());
});

test('installs then configures Wrapper, connects, completes library activation and disconnects', async ({ page, mount }) => {
    await mount('spotifyAccount');
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '① 一键安装', exact: true }).click();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '② 一键配置', exact: true }).click();
    await page.getByRole('button', { name: '启动并连接 Spotify', exact: true }).click();
    await page.getByRole('button', { name: '完成并返回歌单', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('account-state')).toHaveText('authenticated');
    await expect(page.getByText('My Spotify playlist')).toBeVisible();
    await expect(page.getByText('Liked Songs', { exact: true })).toBeVisible();
    const operations = await page.evaluate(() => (window as any).spotifyConnectionProbe.operations as string[]);
    expect(operations.indexOf('desktopSetup:install')).toBeLessThan(operations.indexOf('desktopSetup:configure'));
    expect(operations.some(x => x.startsWith('login'))).toBe(false);
    expect(await page.evaluate(() => (window as any).spotifySavedOffsets)).toEqual([0, 50]);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    await expect(page.getByText('My Spotify playlist')).toHaveCount(0);
});

test('missing Spotify asks the user to install it and blocks component installation', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({ installations: [], selected: undefined }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('未检测到 Spotify。请自行安装官网桌面版或 Microsoft Store 版，并登录账号。')).toBeVisible();
    await expect(page.getByRole('button', { name: '① 一键安装', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '前往 Spotify 下载页', exact: true })).toBeVisible();
});

test('Store installation and restart-required state do not repeat installation', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        installations: [{ id: 'store-1', layout: 'store', version: 'fixture' }], selected: 'store-1',
        install: { phase: 'restart-required', busy: false, restartRequired: true },
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByRole('button', { name: /Microsoft Store 版/ })).toBeVisible();
    await expect(page.getByText('VB-CABLE 安装步骤已完成，请重启 Windows。回来后点击“重新检查”，无需重复安装。')).toBeVisible();
    await expect(page.getByRole('button', { name: '① 一键安装', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新检查', exact: true }).click();
    expect(await page.evaluate(() => (window as any).spotifyConnectionProbe.operations)).not.toContain('desktopSetup:install');
});

test('unfinished guide resumes saved components without login, install or configure', async ({ page, mount }) => {
    await page.addInitScript(() => {
        localStorage.setItem('spotify_connection_pending', 'true');
        (window as any).spotifyConnectionProbe.authenticate();
        (window as any).spotifyConnectionProbe.patch({ cli: true, driver: true, driverEndpointsReady: true, engine: true,
            wrapper: true, extension: true, ready: true, connected: true, running: true });
    });
    await mount('spotifyAccount');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: '完成并返回歌单', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('spotify_connection_pending'))).toBe('true');
    const operations = await page.evaluate(() => (window as any).spotifyConnectionProbe.operations as string[]);
    expect(operations).not.toContain('desktopSetup:install');
    expect(operations).not.toContain('desktopSetup:configure');
    expect(operations.some(x => x.startsWith('login'))).toBe(false);
});

for (const daylight of [false, true]) test(`Wrapper guide uses the shared glass surface (${daylight ? 'light' : 'dark'})`, async ({ page, mount }) => {
    await page.addInitScript(value => localStorage.setItem('default_theme_daylight', String(value)), daylight);
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Spotify' });
    await expect(dialog).toBeVisible();
    const surface = dialog.locator(':scope > div');
    await expect(surface).toHaveCSS('opacity', '1');
    await expect(surface).toHaveCSS('backdrop-filter', 'blur(24px)');
    await expect(surface).toHaveClass(daylight ? /bg-white\/60/ : /bg-black\/40/);
    await page.getByRole('button', { name: 'Close login', exact: true }).click();
    await expect(dialog).toHaveCount(0);
});

test('an unreadable account does not delete its saved grant', async ({ page, mount }) => {
    await page.addInitScript(() => {
        const request = window.electron!.spotify!.request;
        (window as any).spotifyLogoutCalls = 0;
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
