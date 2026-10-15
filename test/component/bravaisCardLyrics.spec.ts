import { test, expect } from './fixtures';

// Exercise the actual canvas, identity gate and metadata fallback in the expanded library card.
test('library card renders and advances lyrics, then restores metadata without lyrics', async ({ mount, page }) => {
    const root = await mount('bravaisCardLyrics');
    await expect(root.locator('.lattice-lyrics.is-ready canvas')).toBeVisible();
    await expect(root.locator('.lattice-lyrics .sr-only')).toHaveText('第一行滚动歌词');
    await page.getByText('Advance lyrics', { exact: true }).click();
    await expect(root.locator('.lattice-lyrics .sr-only')).toHaveText('第二行滚动歌词');
    const lyrics = await root.locator('.lattice-lyrics').boundingBox();
    const controls = await root.locator('.bravais-focus-actions').boundingBox();
    expect(lyrics!.y + lyrics!.height).toBeLessThan(controls!.y);
    await page.screenshot({ path: '../spotify-r37-local/evidence/r2-card-lyrics.png' });
    await page.getByText('No lyrics', { exact: true }).click();
    await expect(root.locator('.folia-no-lyrics--card')).toHaveText('当前歌曲无歌词或为纯音乐，请欣赏');
    await expect(root.locator('[data-bravais-focus-card] strong')).toHaveText('Card title');
});
test('non-current card does not borrow the playing song lyrics', async ({ mount, page }) => {
    const root = await mount('bravaisCardLyrics');
    await expect(root.locator('.lattice-lyrics.is-ready')).toBeVisible();
    await page.getByText('Other card', { exact: true }).click();
    await expect(root.locator('.lattice-lyrics')).toHaveCount(0);
});

test('empty notice is shared by card and details, but not shown during loading or failure', async ({mount,page})=>{
 const root=await mount('bravaisCardLyrics');
 await page.getByText('Loading',{exact:true}).click();await expect(root.locator('.folia-no-lyrics')).toHaveCount(0);
 await page.getByText('No lyrics',{exact:true}).click();await expect(root.locator('.folia-no-lyrics--card')).toHaveText('当前歌曲无歌词或为纯音乐，请欣赏');
 await page.getByText('Details',{exact:true}).click();await expect(root.locator('.folia-no-lyrics--player')).toHaveText('当前歌曲无歌词或为纯音乐，请欣赏');
 await page.screenshot({path:'../spotify-r37-local/evidence/r2-lyrics-notice.png'});
 await page.getByText('Failed',{exact:true}).click();await expect(root.locator('.folia-no-lyrics')).toHaveCount(0);
});
