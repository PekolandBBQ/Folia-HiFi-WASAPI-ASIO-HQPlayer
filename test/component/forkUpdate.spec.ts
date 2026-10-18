import {test,expect} from './fixtures';
// Rendering does not download or install any actual release.
test('fork download is explicit and release notes can be expanded',async({page,mount})=>{
 await page.addInitScript(()=>{Object.assign(window,{electron:{setUpdateSource:async(source:string)=>{document.body.dataset.source=source;return {};},downloadUpdate:async()=>{document.body.dataset.requested='download';return {};}}});});
 await mount('forkUpdate');
 await expect(page.locator('body')).not.toHaveAttribute('data-requested');
 await page.getByLabel('更新来源').selectOption('gitee');await expect(page.locator('body')).toHaveAttribute('data-source','gitee');
 await page.getByText('查看更新说明',{exact:true}).click();await expect(page.getByText('修复首次连接',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'下载便携版 ZIP'}).click();await expect(page.locator('body')).toHaveAttribute('data-requested','download');
});
