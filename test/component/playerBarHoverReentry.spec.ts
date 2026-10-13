import { expect, test } from './fixtures';

// test/component/playerBarHoverReentry.spec.ts

test('returning before the hover grace period keeps the existing pause control mounted and clickable', async ({ mount, page }) => {
    await mount('playerBottomBar');
    const bar = page.locator('[data-ponder="player-bar"]');
    const pause = bar.locator('button:has(svg.lucide-pause)');
    await bar.hover();
    await expect(pause).toBeVisible();
    await page.waitForFunction(() => {
        const element = document.querySelector('[data-ponder="player-bar"]');
        return element && getComputedStyle(element).transform === 'none';
    });
    await pause.evaluate(button => {
        button.dataset.hoverReentryIdentity = 'original';
        button.dataset.trustedClicks = '0';
        button.addEventListener('click', event => {
            if (event.isTrusted) button.dataset.trustedClicks = String(Number(button.dataset.trustedClicks) + 1);
        });
    });
    const barRect = (await bar.boundingBox())!;
    const buttonRect = (await pause.boundingBox())!;
    await page.mouse.move(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
    const beforeLeave = await page.evaluate(() => performance.now());
    await page.mouse.move(barRect.x + barRect.width / 2, barRect.y - 40);
    await page.mouse.move(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
    const returnedAt = await page.evaluate(() => performance.now());
    expect(returnedAt - beforeLeave).toBeLessThan(100);
    // Let the old grace period expire without extra pointer moves that would re-expand the bar.
    await page.waitForTimeout(150);
    expect(await bar.evaluate(element => element.parentElement!.matches(':hover'))).toBe(true);
    await expect(bar.locator('[data-hover-reentry-identity="original"]')).toBeVisible();
    await pause.click();
    await expect(pause).toHaveAttribute('data-trusted-clicks', '1');
    // Keeping the return must not disable a later legitimate collapse.
    await page.mouse.move(barRect.x + barRect.width / 2, barRect.y - 40);
    await expect(pause).toHaveCount(0);
});
