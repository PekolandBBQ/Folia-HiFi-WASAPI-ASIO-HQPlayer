import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedNativeAudioDspMock } from '../helpers/nativeAudioDspMock';

// Real DOM/style/animation checks with mock IPC; these do not count as authenticated streaming or DAC playback.
test.beforeEach(async ({ page }) => { await seedNativeAudioDspMock(page); });
test.setTimeout(30000);

async function expectGlass(surface: Locator, daylight: boolean, playerProgressSurface?: 'collapsed' | 'expanded') {
    const style = await surface.evaluate(el => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, blur: css.backdropFilter, font: css.fontFamily, color: css.color };
    });
    expect(style.background).toMatch(playerProgressSurface
        ? playerProgressSurface === 'expanded' ? daylight ? /0\.6\)/ : /0\.4\)/ : daylight ? /0\.4\)/ : /0\.2\)/
        : daylight ? /0\.[67]\)/ : /0\.(1|65)\)/);
    expect(style.blur).toContain('blur');
    expect(style.font).toContain('Inter');
    return style;
}

/** Sample rendered frames while a trusted action changes the UI; final CSS alone cannot prove a transition. */
async function animationFrames(page: Page, selector: string, action: () => Promise<unknown>) {
    await page.evaluate(selector => {
        const frames: { opacity: number; center: number; translate: string }[] = [], start = performance.now();
        (window as any).__audioAnimation = new Promise(resolve => {
            const sample = () => {
                const el = document.querySelector(selector);
                if (el) { const style = getComputedStyle(el), box = el.getBoundingClientRect(); frames.push({ opacity: Number(style.opacity), center: box.x + box.width / 2, translate: style.translate }); }
                if (performance.now() - start >= 380) resolve(frames); else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
    }, selector);
    await action();
    return page.evaluate(async () => await (window as any).__audioAnimation) as Promise<{ opacity: number; center: number; translate: string }[]>;
}

for (const daylight of [false, true]) test(`loading details are measured, frosted and clear of the song toast (${daylight ? 'light' : 'dark'})`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mount('playbackPreparation', { daylight });
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const trigger = page.getByRole('button', { name: '加载详情', exact: true });
    await trigger.click();
    const panel = page.getByRole('region', { name: '加载详情', exact: true });
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByText('1.0 MB / 4.0 MB', { exact: true })).toBeVisible();
    await expect(panel.getByText('当前阶段', { exact: true })).toBeVisible();
    await expect(panel.getByText('已用时', { exact: true })).toBeVisible();
    await page.mouse.move(10, 10);
    await page.locator('[data-playback-load]').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
    const compact = await expectGlass(page.locator('[data-playback-load]'), daylight, 'collapsed'), detail = await expectGlass(panel, daylight, 'expanded');
    expect(detail.color).toBe(compact.color);
    const toast = (await page.locator('[data-now-playing-toast]').boundingBox())!, box = (await panel.boundingBox())!;
    expect(toast.y - box.y - box.height).toBeGreaterThanOrEqual(8);
    const audioControls = (await page.locator('[data-signal-path]').boundingBox())!;
    expect(audioControls.y - box.y - box.height).toBeGreaterThanOrEqual(8);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Decode', exact: true }).evaluate(el => (el as HTMLButtonElement).click());
    await expect(panel.getByText('此阶段不提供百分比。', { exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).not.toHaveAttribute('value');
    await page.getByRole('button', { name: 'Buffer', exact: true }).evaluate(el => (el as HTMLButtonElement).click());
    await expect(panel.getByText('0.20 秒 / 0.35 秒', { exact: true })).toBeVisible();
    await expect(panel.getByText(/正在等待足够的音频继续播放/)).toBeVisible();
    await page.getByRole('button', { name: 'Resume download', exact: true }).evaluate(el => (el as HTMLButtonElement).click());
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '50');
    await expect(panel.getByText('2.0 MB / 4.0 MB', { exact: true })).toBeVisible();
    await page.screenshot({ path: `artifacts/local-validation/audio-ui-final/loading-details-${daylight ? 'light' : 'dark'}.png` });
    const frames = await animationFrames(page, '[aria-label="加载详情"][role="region"]', () => panel.getByRole('button', { name: '关闭加载详情' }).evaluate(el => (el as HTMLButtonElement).click()));
    expect(frames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
});

for (const daylight of [false, true]) test(`first HQPlayer read reserves a complete layout, then reopens cached fields during refresh and recovers failure (${daylight ? 'light' : 'dark'})`, async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('mock_hqp_deferred_read', 'true'));
    await mount('playbackPreparation', { daylight });
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(1);
    await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'HQPlayer 升频设置' });
    await expect(panel.locator('[data-hqplayer-dsp-skeleton]')).toBeVisible();
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByRole('button', { name: '应用到当前歌曲', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '下一首歌曲生效', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `artifacts/local-validation/audio-ui-final/hqplayer-skeleton-${daylight ? 'light' : 'dark'}.png` });
    await page.evaluate(() => (window as any).__failDspRead());
    await expect(panel.locator('[data-hqplayer-dsp-skeleton]')).toHaveCount(0);
    await expect(panel.getByRole('status')).not.toHaveText('');
    await panel.getByRole('button', { name: '刷新选项', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(1);
    await page.evaluate(() => (window as any).__finishDspRead());
    await expect(panel.locator('[aria-haspopup="listbox"]')).toHaveCount(4);
    await expect(panel.getByRole('button', { name: '目标采样率', exact: true })).toHaveText('192 kHz');
    await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
    expect(await panel.locator('[aria-haspopup="listbox"]').count()).toBe(4);
    await expect(panel.locator('[data-hqplayer-dsp-skeleton]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(1);
    await page.evaluate(() => (window as any).__failDspRead());
    await expect(panel.getByRole('button', { name: '目标采样率', exact: true })).toHaveText('192 kHz');
    await panel.getByRole('button', { name: '刷新选项', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(1);
    await page.evaluate(() => (window as any).__finishDspRead(0, 384000));
    await expect(panel.getByRole('button', { name: '目标采样率', exact: true })).toHaveText('384 kHz');
    for (const label of ['升频模式', '滤波器', '整形器 / 调制器', '目标采样率']) {
        const field = panel.getByRole('button', { name: label, exact: true });
        await expect(field).toBeEnabled(); await expect(field).toHaveCSS('opacity', '1');
    }
    await expect(panel.getByRole('button', { name: '应用到当前歌曲', exact: true })).toBeEnabled();
    await expect(panel.locator('[data-hqplayer-dsp-ready]')).toHaveAttribute('aria-busy', 'false');
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({ path: `artifacts/local-validation/audio-ui-final/hqplayer-settings-${daylight ? 'light' : 'dark'}.png` });
});

test('a new HQPlayer session cannot show or apply the old session catalog while reads are outstanding', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('mock_hqp_deferred_read', 'true'));
    await mount('playbackPreparation');
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(1);
    await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'HQPlayer 升频设置' });
    await page.getByRole('button', { name: 'New session', exact: true }).evaluate(el => (el as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => (window as any).__pendingDspReadCount())).toBe(2);
    await page.evaluate(() => (window as any).__finishDspRead(0, 96000));
    await expect(panel.locator('[data-hqplayer-dsp-skeleton]')).toBeVisible();
    await expect(panel.getByRole('button', { name: '目标采样率', exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).__finishDspRead(0, 384000));
    await expect(panel.getByRole('button', { name: '目标采样率', exact: true })).toHaveText('384 kHz');
    await expect(panel.getByRole('button', { name: '应用到当前歌曲', exact: true })).toBeEnabled();
});

for (const daylight of [false, true]) test(`audio drawer and disclosures animate without horizontal drift, use glass and leave lyrics clear (${daylight ? 'light' : 'dark'})`, async ({ mount, page }) => {
    await mount('playerBottomBar', { audioDetails: true, daylight });
    const drawer = page.locator('[data-signal-path]'), bar = page.locator('[data-ponder="player-bar"]');
    await expect(drawer).toHaveCSS('opacity', '1');
    const initial = (await drawer.boundingBox())!, lyric = page.locator('[data-probe-subtitle-host]').getByText('Probe subtitle', { exact: true });
    await expect.poll(async () => { const a = await drawer.boundingBox(), b = await lyric.boundingBox(); return a && b ? a.y - b.y - b.height : -1; }).toBeGreaterThanOrEqual(4);
    expect(initial.height).toBeLessThanOrEqual(28);
    const capsule = (await bar.boundingBox())!;
    const frames = await animationFrames(page, '[data-signal-path]', () => page.mouse.move(capsule.x + capsule.width / 2, capsule.y + capsule.height / 2));
    expect(frames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    expect(Math.max(...frames.map(frame => Math.abs(frame.center - initial.x - initial.width / 2)))).toBeLessThan(1);
    await expect(drawer).toHaveCSS('translate', '-50% 32px'); await expect(drawer).toHaveAttribute('inert', '');
    await page.mouse.move(10, 10); await expect(drawer).toHaveCSS('opacity', '1');
    const hqFrames = await animationFrames(page, '[role="region"][aria-label="HQPlayer 升频设置"]', () => page.getByRole('button', { name: 'HQPlayer设置', exact: true }).evaluate(el => (el as HTMLButtonElement).click()));
    expect(hqFrames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    const hq = page.getByRole('region', { name: 'HQPlayer 升频设置' });
    await expect(hq).toHaveCSS('opacity', '1');
    await expectGlass(hq, daylight);
    await hq.getByRole('button', { name: '滤波器', exact: true }).click();
    await expectGlass(page.getByRole('listbox'), daylight);
    await expect(page.getByRole('listbox')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: `artifacts/local-validation/audio-ui-final/hqplayer-select-${daylight ? 'light' : 'dark'}.png` });
    await page.getByRole('option', { name: 'poly-sinc', exact: true }).click();
    await expect(hq.locator('[type="checkbox"], [type="radio"]')).toHaveCount(0);
    await expect(hq.getByRole('switch')).toHaveCount(1);
    const exit = await animationFrames(page, '[role="region"][aria-label="HQPlayer 升频设置"]', () => hq.getByRole('button', { name: '关闭音频链路' }).evaluate(el => (el as HTMLButtonElement).click()));
    expect(exit.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    await expect(hq).toHaveCount(0);
    const enter = await animationFrames(page, '[role="region"][aria-label="音频链路"]', () => drawer.locator(':scope > button').evaluate(el => (el as HTMLButtonElement).click()));
    expect(enter.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    const signal = page.getByRole('region', { name: '音频链路', exact: true });
    await expect(signal).toHaveCSS('opacity', '1');
    await expectGlass(signal, daylight);
    await page.screenshot({ path: `artifacts/local-validation/audio-ui-final/signal-path-${daylight ? 'light' : 'dark'}.png` });
    expect(await drawer.locator(':scope > button').evaluate(el => getComputedStyle(el).fontSize)).toBe('11px');
    const signalExit = await animationFrames(page, '[role="region"][aria-label="音频链路"]', () => signal.getByRole('button', { name: '关闭音频链路' }).evaluate(el => (el as HTMLButtonElement).click()));
    expect(signalExit.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
});

for (const setting of ['explicit', 'follow-system']) test(`reduced motion applies to loading, drawer and select (${setting})`, async ({ mount, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(setting => localStorage.setItem(setting === 'explicit' ? 'reduce_motion_uiMicroMotion' : 'reduce_motion_follow_system', 'true'), setting);
    await mount('playbackPreparation');
    await page.getByRole('button', { name: 'Decode', exact: true }).click();
    await expect(page.getByRole('progressbar')).toHaveCSS('animation-name', 'none');
    await page.getByRole('button', { name: '加载详情', exact: true }).click();
    const details = page.getByRole('region', { name: '加载详情', exact: true });
    await expect(details).toHaveCSS('opacity', '1');
    await details.getByRole('button', { name: '关闭加载详情' }).click(); await expect(details).toHaveCount(0);
    await mount('playerBottomBar', { audioDetails: true });
    const drawer = page.locator('[data-signal-path]');
    await expect(drawer).toHaveCSS('transition-duration', '0s');
    await page.getByRole('button', { name: 'HQPlayer设置', exact: true }).click();
    const hq = page.getByRole('region', { name: 'HQPlayer 升频设置' });
    const filter = hq.getByRole('button', { name: '滤波器', exact: true });
    await expect(filter).toHaveCSS('transition-duration', '0s'); await filter.click();
    await expect(page.getByRole('listbox')).toHaveCSS('opacity', '1');
    await page.getByRole('option', { name: 'poly-sinc', exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('retains a saved foreground launch choice rather than replacing it with the new default', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_hqplayer_silent_launch', 'false'));
    await mount('playbackPreparation');
    await expect(page.getByRole('switch', { name: '后台静默开启 HQPlayer', exact: true })).not.toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('folia_hqplayer_silent_launch'))).toBe('false');
    await expect(page.locator('[type="checkbox"], [type="radio"]')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: '兼容模式', exact: true })).not.toBeChecked();
});
