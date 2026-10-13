import { test, expect } from './fixtures';

// This is UI contract coverage with observed-source fixtures, not real provider or DAC playback acceptance.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
});
test('shows a normal lossless fallback separately from requested HiRes and genuine 24/48 HiRes', async ({ mount, page }) => {
    await mount('sourceQuality');
    await page.locator('[data-signal-path] > button').click();
    const panel = page.getByRole('region', { name: '音频链路', exact: true });
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByText('请求: HiRes · 实际返回: 无损', { exact: true })).toBeVisible();
    await expect(panel.getByText('FLAC · 44.1 kHz · 16-bit', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/local-validation/audio-ui-final/source-quality-fallback.png' });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Verified HiRes', exact: true }).click();
    await expect(page.locator('[data-signal-path] > button')).toContainText('48 kHz / 24-bit');
    await page.locator('[data-signal-path] > button').click();
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByText('请求: HiRes · 实际返回: HiRes', { exact: true })).toBeVisible();
    await expect(panel.getByText('FLAC · 48 kHz · 24-bit', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/local-validation/audio-ui-final/source-quality-hires.png' });
});
test('leaves original source facts unknown for generated PCM while still reporting the output format', async ({ mount, page }) => {
    await mount('sourceQuality');
    await page.getByRole('button', { name: 'Prepared unknown', exact: true }).click();
    await page.locator('[data-signal-path] > button').click();
    const panel = page.getByRole('region', { name: '音频链路', exact: true });
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.getByText('请求: 高音质 · 实际返回: 未回报', { exact: true })).toBeVisible();
    await expect(panel.getByText('未回报 · 未回报', { exact: true })).toBeVisible();
    await expect(panel.getByText('PCM float32', { exact: true })).toBeVisible();
    await expect(panel.getByText(/WAV|32-bit/)).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/local-validation/audio-ui-final/source-quality-unknown.png' });
});
