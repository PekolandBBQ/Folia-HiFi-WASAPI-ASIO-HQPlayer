import { expect, test } from './fixtures';

// publicPlaylistMetadata.spec.ts — Cloud browser component QA, with no real account or playback.
test('marks the 23 public entries incomplete with a safe origin link in both themes', async ({ mount, page }) => {
    await mount('publicPlaylistMetadata');
    const notice = page.getByTestId('collection-metadata-notice');
    await expect(notice).toContainText('23 track entries');
    await expect(notice).toContainText('may be incomplete');
    await expect(notice).toContainText('total is not confirmed');
    const link = notice.getByRole('link');
    await expect(link).toHaveAttribute('href', 'https://open.spotify.com/playlist/5ZAFjUGN7Wsip8May2qDuq');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await page.screenshot({ path: '../reports/public-playlist-notice-dark.png' });
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(notice).toBeVisible();
    await page.setViewportSize({ width: 420, height: 740 });
    const bounds = await notice.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420);
    await page.screenshot({ path: '../reports/public-playlist-notice-light-compact.png' });
});

test('clears provenance on API, close and repeated reopen without triggering the title panel', async ({ mount, page }) => {
    await mount('publicPlaylistMetadata');
    const notice = page.getByTestId('collection-metadata-notice');
    await notice.locator('span').click();
    await expect(page.getByTestId('parent-clicks')).toHaveText('0');
    for (let i = 0; i < 2; i++) {
        await page.getByRole('button', { name: 'API', exact: true }).click();
        await expect(notice).toHaveCount(0);
        await page.getByRole('button', { name: 'Public', exact: true }).click();
        await expect(notice).toBeVisible();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(notice).toHaveCount(0);
        await page.getByRole('button', { name: 'Public', exact: true }).click();
        await expect(notice).toBeVisible();
    }
});
