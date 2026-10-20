import { test, expect } from './fixtures';
import { automaticCableStatus } from '../unit/onlineMusic/spotifyCableFixture';

// Production Wrapper guide/library controller, synthetic IPC only. Not an installation or playback claim.
test('connected bridge preserves a concrete audio failure and refreshes when Spotify exits', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        running: true, connected: true, cli: true, wrapper: true, extension: true,
        driver: true, driverEndpointsReady: true, engine: true,
        playback: { state: 'failed', detail: '路由准备失败：ORIGINAL_ENDPOINT_UNSAFE [route-inspect]' },
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('Spotify 连接：已连接，可搜索和收藏歌曲', { exact: true })).toBeVisible();
    await expect(page.getByText('音频链路：路由准备失败：ORIGINAL_ENDPOINT_UNSAFE [route-inspect]', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).spotifyConnectionProbe.patch({ running: false, connected: false }));
    await expect(page.getByText('Spotify 连接：尚未启动，使用时将自动连接', { exact: true })).toBeVisible({ timeout: 12000 });
    await expect(page.getByText('音频链路：路由准备失败：ORIGINAL_ENDPOINT_UNSAFE [route-inspect]', { exact: true })).toBeVisible();
});

test('component discovery errors remain visible independently of bridge readiness', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        running: true, connected: false, engine: false,
        issues: [{ detail: '采集组件不可用：COMPONENT_PROTOCOL_MISMATCH [capture-devices]' }],
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('采集组件不可用：COMPONENT_PROTOCOL_MISMATCH [capture-devices]', { exact: true })).toBeVisible();
    await expect(page.getByText('Spotify 连接：尚未连接，Folia 会在使用时自动处理', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeDisabled();
});

test('VB default output is informational and does not require another DAC for process capture', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        running: true, connected: true, cli: true, wrapper: true, extension: true, ready: true,
        driver: true, driverEndpointsReady: true, engine: true,
        systemOutput: { state: 'cable', names: ['CABLE Input'] },
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('HQPlayer 或独占驱动占用唯一的 DAC 时，可继续播放，无需额外的 Windows 输出设备。其他程序的声音不会通过 Spotify 采集进入 Folia。')).toBeVisible();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '完成并返回歌单', exact: true })).toBeEnabled();
    await expect(page.getByText(/请选择实际扬声器或 DAC 后再继续/)).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript(cable => {
        localStorage.setItem('active_online_provider_id', 'spotify');
        let authenticated = false;
        let status = {
            bridgeRuntime: { state: 'ready', detail: '' }, enabled: true, installations: [{ id: 'desktop-1', layout: 'desktop', version: 'fixture' }], selected: 'desktop-1',
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
                if (input.operation === 'configure') { authenticated = true; status = { ...status, wrapper: true, extension: true, running: true, connected: true, ready: true, install: { ...status.install, phase: 'complete' } }; }
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
    await expect(page.getByTestId('account-state')).toHaveText('unknown');
    expect(await page.evaluate(() => (window as any).spotifyConnectionProbe.operations)).toEqual([]);
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '① 一键安装', exact: true }).click();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '② 一键配置', exact: true }).click();
    await expect(page.getByRole('button', { name: '启动并连接 Spotify', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '完成并返回歌单', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('account-state')).toHaveText('authenticated');
    await expect(page.getByText('My Spotify playlist')).toBeVisible();
    await expect(page.getByText('Liked Songs', { exact: true })).toBeVisible();
    const operations = await page.evaluate(() => (window as any).spotifyConnectionProbe.operations as string[]);
    expect(operations.indexOf('desktopSetup:install')).toBeLessThan(operations.indexOf('desktopSetup:configure'));
    expect(operations).not.toContain('desktopSetup:launch');
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

test('unfinished marker does not open a guide on startup', async ({ page, mount }) => {
    await page.addInitScript(() => {
        localStorage.setItem('spotify_connection_pending', 'true');
        (window as any).spotifyConnectionProbe.authenticate();
        (window as any).spotifyConnectionProbe.patch({ cli: true, driver: true, driverEndpointsReady: true, engine: true,
            wrapper: true, extension: true, ready: true, connected: true, running: true });
    });
    await mount('spotifyAccount');
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
    await expect(page.getByTestId('account-state')).toHaveText('unknown');
    expect(await page.evaluate(() => (window as any).spotifyConnectionProbe.operations)).toEqual([]);
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByTestId('account-state')).toHaveText('anonymous');
    expect(await page.evaluate(() => (window as any).spotifyLogoutCalls)).toBe(0);
});

test('an installed CLI still needs configuration and an old driver blocks configuration', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        cli: true, driver: true, driverCurrent: false, driverEndpointsReady: true, engine: true,
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('Spicetify：已安装，待配置')).toBeVisible();
    await expect(page.getByText('VB-CABLE：版本需更新，请完成一键安装')).toBeVisible();
    await expect(page.getByRole('button', { name: '② 一键配置', exact: true })).toBeDisabled();
});

test('an unavailable latest component manifest offers retry and does not claim latest', async ({ page, mount }) => {
    await page.addInitScript(() => (window as any).spotifyConnectionProbe.patch({
        install: { phase: 'failed', code: 'SPOTIFY_COMPONENT_UPDATE_CHECK_FAILED', busy: false },
    }));
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await expect(page.getByText('无法核对最新组件清单，请联网后重试安装。')).toBeVisible();
    await expect(page.getByRole('button', { name: '① 一键安装', exact: true })).toBeEnabled();
});

for (const accept of [true, false]) test(`completing setup exposes the provider confirmation (${accept ? 'confirm' : 'cancel'})`, async ({ page, mount }) => {
    await page.addInitScript(() => {
        localStorage.setItem('active_online_provider_id', 'netease');
        (window as any).spotifyConnectionProbe.authenticate();
        (window as any).spotifyConnectionProbe.patch({ cli: true, driver: true, driverEndpointsReady: true, engine: true,
            wrapper: true, extension: true, ready: true, connected: true, running: true });
    });
    await mount('spotifyAccount');
    await page.getByRole('button', { name: 'Connect Spotify', exact: true }).click();
    await page.getByRole('button', { name: '完成并返回歌单', exact: true }).click();
    await page.getByRole('button', { name: accept ? 'Confirm provider switch' : 'Cancel provider switch', exact: true }).click();
    if (accept) {
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByText('My Spotify playlist')).toBeVisible();
    } else {
        await expect(page.getByRole('button', { name: '完成并返回歌单', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '① 一键安装', exact: true })).toBeEnabled();
        expect(await page.evaluate(() => localStorage.getItem('active_online_provider_id'))).toBe('netease');
    }
});
