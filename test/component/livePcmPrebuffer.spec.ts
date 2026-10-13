import { test, expect } from './fixtures';

// Native browser range semantics, exact saved units, theme/focus visibility and independent HQ delay.
test('supports keyboard limits, disabled controls and both themes', async ({ page }) => {
    await page.goto('/dev-probe.html?probe=livePcmPrebuffer');
    const light = page.getByTestId('light-settings'), dark = page.getByTestId('dark-settings');
    const slider = light.getByRole('slider').first();
    await expect(slider).toHaveValue('350');
    await slider.focus(); await page.keyboard.press('Home'); await expect(slider).toHaveValue('25');
    await page.keyboard.press('ArrowRight'); await expect(slider).toHaveValue('26');
    await page.keyboard.press('End'); await expect(slider).toHaveValue('1000');
    await expect(light.locator('output').first()).toHaveText('1000 ms');
    await expect(dark.getByRole('slider').first()).toHaveValue('1000');
    expect(await page.evaluate(() => localStorage.getItem('folia_live_pcm_prebuffer_ms'))).toBe('1000');
    await expect(light.getByRole('slider').last()).toBeDisabled();
    await expect(light.getByRole('spinbutton')).toHaveCount(1);
    await expect(light.getByRole('spinbutton')).toBeDisabled();
    expect(await slider.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await expect(light).toBeVisible(); await expect(dark).toBeVisible();
    await page.screenshot({ path: 'test-results/live-pcm-prebuffer-themes.png', fullPage: true });
});
