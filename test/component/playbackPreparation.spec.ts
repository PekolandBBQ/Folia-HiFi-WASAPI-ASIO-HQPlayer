import { test, expect } from './fixtures';

// Validate user-visible scope choices, honest loading progress, and staged HQPlayer settings.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('i18nextLng', 'zh-CN');
        const requests: unknown[] = [];
        Object.assign(window, { __dspRequests: requests, electron: { platform: 'win32', nativeAudio: {
            supported: true, onEvent: () => () => {}, request: async (request: { action: string }) => {
                requests.push(request);
                if (request.action === 'hqplayer-status') return { available: true, needsConfirmation: localStorage.getItem('mock_hqp_existing') === 'true', instancePid: 77 };
                if (request.action === 'hqplayer-dsp-read') return {
                    state: { mode: 1, filter: 3, shaper: 4, rate: 2, state: 0 }, pending: null,
                    modes: [{ index: 1, name: 'PCM', value: 0 }, { index: 2, name: 'SDM (DSD)', value: 1 }],
                    catalogs: {
                        1: { filters: [{ index: 3, name: 'poly-sinc' }], shapers: [{ index: 4, name: 'TPDF' }], rates: [{ index: 2, rate: 192000 }] },
                        2: { filters: [{ index: 7, name: 'poly-sinc-gauss' }], shapers: [{ index: 8, name: 'ASDM7EC-fast' }], rates: [{ index: 9, rate: 22579200 }] },
                    }, deviceControlAvailable: false,
                };
                return { ok: true };
            },
        } } });
    });
});
test('shows measured download progress and an indeterminate decoding state', async ({ mount, page }) => {
    await mount('playbackPreparation');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '25');
    await expect(page.getByText('25%', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/playback-download.png' });
    await page.getByRole('button', { name: 'Decode', exact: true }).click();
    await expect(page.getByRole('progressbar')).not.toHaveAttribute('value');
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
});
for (const width of [1280, 390]) {
    test(`keeps compact preparation below the song toast at ${width}px`, async ({ mount, page }) => {
        await page.setViewportSize({ width, height: 800 });
        await mount('playbackPreparation');
        await page.getByRole('button', { name: 'Download', exact: true }).click();
        const load = page.locator('[data-playback-load]'), toast = page.locator('[data-now-playing-toast]');
        await expect(toast).toBeVisible();
        await expect.poll(async () => {
            const a = await load.boundingBox(), b = await toast.boundingBox();
            return a && b ? a.y - (b.y + b.height) : -1;
        }).toBeGreaterThanOrEqual(3);
        const box = (await load.boundingBox())!;
        expect(box.height).toBeLessThanOrEqual(22); expect(box.width).toBeLessThanOrEqual(256);
        expect(800 - box.y - box.height).toBe(8);
        await page.screenshot({ path: `test-results/playback-compact-${width}.png` });
    });
}
test('defaults off, offers one-song recovery, and persists only keep-enabled', async ({ mount, page }) => {
    await mount('playbackPreparation');
    const toggle = page.getByRole('switch', { name: '兼容模式', exact: true }); await expect(toggle).not.toBeChecked();
    await page.getByRole('button', { name: 'Strict error' }).click();
    await page.getByRole('button', { name: '仅当前歌曲', exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await page.getByRole('button', { name: 'Strict error' }).click();
    await page.screenshot({ path: 'test-results/playback-compatibility.png' });
    await page.getByRole('button', { name: '后续保持开启', exact: true }).click();
    await expect(toggle).toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('folia_decode_compatibility'))).toBe('true');
});
test('persists default DSP values without applying them to the currently playing song', async ({ mount, page }) => {
    await mount('playbackPreparation');
    await page.getByRole('button', { name: '刷新选项', exact: true }).click();
    await page.getByRole('button', { name: '升频模式', exact: true }).click();
    await page.getByRole('option', { name: 'SDM (DSD)', exact: true }).click();
    await page.getByRole('button', { name: '保存为默认值', exact: true }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('folia_hqplayer_dsp_defaults') || 'null'))).toMatchObject({ mode: 2, rate: 22579200, shaper: 'ASDM7EC-fast' });
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: { action: string }[] }).__dspRequests.some(r => r.action === 'hqplayer-dsp-apply'))).toBe(false);
    await page.getByRole('button', { name: '使用 HQPlayer 当前设置', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('folia_hqplayer_dsp_defaults'))).toBe('null');
});
test('stages mode-specific choices and sends explicit current or next application', async ({ mount, page }) => {
    await mount('playbackPreparation');
    await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
    await page.getByRole('button', { name: '升频模式', exact: true }).click();
    await page.getByRole('option', { name: 'SDM (DSD)', exact: true }).click();
    await expect(page.getByRole('button', { name: '目标采样率', exact: true })).toHaveText('44.1k x512');
    await page.getByRole('button', { name: '滤波器', exact: true }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('option', { name: 'poly-sinc-gauss', exact: true }).click();
    await expect(page.getByRole('region', { name: 'HQPlayer 升频设置' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: { action: string }[] }).__dspRequests.filter(item => item.action === 'hqplayer-dsp-apply'))).toHaveLength(0);
    await page.screenshot({ path: 'test-results/playback-hqp-dsp.png' });
    await page.getByRole('button', { name: '下一首歌曲生效', exact: true }).click();
    await expect(page.getByText('已保存，下一首歌曲开始前生效。')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: unknown[] }).__dspRequests.at(-1))).toMatchObject({ action: 'hqplayer-dsp-apply', when: 'next', settings: { mode: 2, rate: 22579200 } });
    await page.getByRole('button', { name: '应用到当前歌曲', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: unknown[] }).__dspRequests.at(-1))).toMatchObject({ when: 'current', session: 'probe-session' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'HQPlayer 升频设置' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear song', exact: true }).click();
    await expect(page.getByRole('button', { name: 'HQPlayer设置', exact: true })).toBeVisible();
});
test('asks before connecting an existing instance and defaults silent launch off', async ({ mount, page }) => {
    await mount('playbackPreparation');
    const silent = page.getByRole('switch', { name: '后台静默开启 HQPlayer', exact: true });
    await expect(silent).not.toBeChecked(); await silent.check();
    expect(await page.evaluate(() => localStorage.getItem('folia_hqplayer_silent_launch'))).toBe('true');
    await page.evaluate(() => {
        localStorage.setItem('mock_hqp_existing', 'true');
        localStorage.setItem('folia_hqplayer_previous_output', JSON.stringify({ backend: 'asio', deviceId: 'previous-dac' }));
    });
    await page.getByRole('button', { name: 'Connect existing', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '否，返回先前设置', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('asio');
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_device'))).toBe('previous-dac');
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: { action: string }[] }).__dspRequests.some(item => item.action === 'hqplayer-authorize-existing'))).toBe(false);
    await page.getByRole('button', { name: 'Connect existing', exact: true }).click();
    await page.screenshot({ path: 'test-results/playback-existing-hqp.png' });
    await page.getByRole('button', { name: '是，连接已有实例', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __dspRequests: unknown[] }).__dspRequests)).toContainEqual({ action: 'hqplayer-authorize-existing', instancePid: 77 });
});
