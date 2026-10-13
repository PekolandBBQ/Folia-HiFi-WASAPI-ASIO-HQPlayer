import { expect, test } from './fixtures';

// Browser signal-path disclosure uses synthetic format observations and never plays audio.
test('shows separate source and PCM facts; closes on Escape, outside click and source replacement', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mount('signalPathBrowser');
    const trigger = page.getByRole('button', { name: 'Received PCM · 44.1 kHz / 32-bit' });
    const panel = page.getByRole('region', { name: 'Signal path', exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Original codec, sample rate and bit depth not reported');
    await expect(panel).toContainText('Requested: Lossless · Returned: Not reported');
    await expect(panel).toContainText('s32le · 44.1 kHz · 32-bit · 2 ch');
    await expect(panel).toContainText('Web Audio float32 · 44.1 kHz');
    await expect(panel).toHaveAttribute('data-columns', 'true');
    const box = await panel.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: 'test-results/signal-path-browser-dark.png' });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(panel).toBeHidden();
    await trigger.click();
    await expect(panel).toBeVisible();
    await page.screenshot({ path: 'test-results/signal-path-browser-light.png' });
    await page.getByRole('button', { name: 'Ordinary browser', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeHidden();
    await page.getByRole('button', { name: 'Spotify browser', exact: true }).click();
    await expect(trigger).toBeVisible();
    await expect(panel).toBeHidden();
    await trigger.click();
    await page.getByRole('button', { name: 'Hide signal', exact: true }).click();
    await expect(trigger).toBeHidden();
});

test('fits a narrow viewport with reduced motion', async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount('signalPathBrowser');
    await page.getByRole('button', { name: 'Received PCM · 44.1 kHz / 32-bit' }).click();
    const panel = page.getByRole('region', { name: 'Signal path', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-columns', 'false');
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThan(844);
    await page.screenshot({ path: 'test-results/signal-path-browser-narrow.png' });
});
