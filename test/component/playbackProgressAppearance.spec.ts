import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedNativeAudioDspMock } from '../helpers/nativeAudioDspMock';

// test/component/playbackProgressAppearance.spec.ts
// Compare the real loading disclosure with the real song capsule, rather than a copied CSS expectation.
const readSurface = (surface: Locator) => surface.evaluate(el => {
    const css = getComputedStyle(el);
    // CSS transitions may serialize the same paint as oklab or color(srgb); compare the actual RGBA paint.
    const context = document.createElement('canvas').getContext('2d')!;
    const paint = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    return { background: paint(css.backgroundColor), borderColor: paint(css.borderTopColor), borderWidth: css.borderTopWidth,
        blur: css.backdropFilter, shadow: css.boxShadow, opacity: css.opacity, font: css.fontFamily };
});
const readText = (text: Locator) => text.evaluate(el => {
    const css = getComputedStyle(el);
    return { color: css.color, opacity: css.opacity, family: css.fontFamily, size: css.fontSize,
        weight: css.fontWeight, lineHeight: css.lineHeight };
});

test.beforeEach(async ({ page }) => { await seedNativeAudioDspMock(page); });

for (const daylight of [false, true]) {
    for (const background of ['light', 'dark'] as const) {
        test(`loading reuses song progress appearance: ${daylight ? 'day' : 'night'} on ${background} background`, async ({ mount, page }) => {
            await mount('playerBottomBar', { audioDetails: true, loadingAppearance: true, daylight, background });
            await page.mouse.move(10, 10);
            const load = page.locator('[data-playback-load]');
            const bar = page.locator('[data-ponder="player-bar"]');
            const songGlass = bar.locator(':scope > [aria-hidden="true"]');
            await expect(load).toBeVisible();
            await expect(bar.locator('[data-folium-part="progress.time"]')).toHaveText('00:42');
            expect(await readSurface(load)).toEqual(await readSurface(songGlass));
            const numeric = await readText(load.locator('[data-playback-load-completion]'));
            const songTime = await readText(bar.locator('[data-folium-part="progress.time"]'));
            expect(numeric).toEqual(songTime);
            const stage = await readText(load.getByRole('status'));
            expect({ ...stage, family: songTime.family }).toEqual(songTime);
            expect(stage.family).toBe((await readSurface(songGlass)).font);
            const loadColors = await load.getByRole('progressbar').evaluate(el => {
                const css = getComputedStyle(el); return { fill: css.color, track: css.backgroundColor };
            });
            expect(loadColors).toEqual({
                fill: await bar.locator('[data-folium-part="progress.fill"]').evaluate(el => getComputedStyle(el).backgroundColor),
                track: await bar.locator('[data-folium-part="progress.track"]').evaluate(el => getComputedStyle(el).backgroundColor),
            });
            const before = (await bar.boundingBox())!;
            await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
            await expect(bar.getByText('Probe Song', { exact: true })).toBeVisible();
            // Finish the existing transition rather than sampling an intermediate glass alpha.
            await songGlass.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
            const expanded = await readSurface(songGlass);
            const titleColor = await bar.getByText('Probe Song', { exact: true }).evaluate(el => getComputedStyle(el).color);
            await load.getByRole('button', { name: '加载详情', exact: true }).click();
            const details = page.getByRole('region', { name: '加载详情', exact: true });
            await expect(details).toHaveCSS('opacity', '1');
            expect(await readSurface(details)).toEqual(expanded);
            await expect(details).toHaveCSS('color', titleColor);
            await expect(details.getByText('1.0 MB / 4.0 MB', { exact: true })).toBeVisible();
            await page.screenshot({ path: `artifacts/local-validation/progress-style-20261002/${daylight ? 'day' : 'night'}-${background}.png` });
        });
    }
    test(`matching loading style remains compact and leaves the song toast clear at 390px (${daylight ? 'day' : 'night'})`, async ({ mount, page }) => {
        await page.setViewportSize({ width: 390, height: 800 });
        await mount('playerBottomBar', { audioDetails: true, loadingAppearance: true, daylight });
        await page.mouse.move(10, 10);
        const load = page.locator('[data-playback-load]');
        const toast = page.locator('[data-now-playing-toast]');
        await expect(toast).toHaveCSS('opacity', '1');
        const compactBox = (await load.boundingBox())!, toastBox = (await toast.boundingBox())!;
        expect(compactBox.height).toBeLessThanOrEqual(22); expect(compactBox.width).toBeLessThanOrEqual(256);
        expect(800 - compactBox.y - compactBox.height).toBe(8);
        expect(compactBox.y - toastBox.y - toastBox.height).toBeGreaterThanOrEqual(3);
        expect(await readSurface(load)).toEqual(await readSurface(page.locator('[data-ponder="player-bar"] > [aria-hidden="true"]')));
        await load.getByRole('button', { name: '加载详情', exact: true }).click();
        const details = page.getByRole('region', { name: '加载详情', exact: true });
        await expect(details).toHaveCSS('opacity', '1');
        const detailBox = (await details.boundingBox())!;
        expect(detailBox.x).toBeGreaterThanOrEqual(0); expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(390);
        expect(toastBox.y - detailBox.y - detailBox.height).toBeGreaterThanOrEqual(8);
        await page.screenshot({ path: `artifacts/local-validation/progress-style-20261002/${daylight ? 'day' : 'night'}-390.png` });
    });
}
