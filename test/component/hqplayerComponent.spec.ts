import { test, expect } from './fixtures';

// HQPlayer installation is an independent user decision, never an implicit WASAPI installation.
test('installs and disables only the independent HQPlayer component and displays its version', async ({ page, mount }) => {
    await page.addInitScript(() => {
        localStorage.setItem('i18nextLng', 'zh-CN'); let installed = false;
        const requests: string[] = [];
        const status = () => ({ available: installed, executablePath: 'D:\\HQPlayer6Desktop.exe',
            component: { available: installed, installed, installable: true, version: installed ? '0.1.0' : undefined, rollbackAvailable: false } });
        Object.assign(window, { __componentRequests: requests, electron: { platform: 'win32', nativeAudio: { supported: true, onEvent: () => () => {}, request: async ({ action }: { action: string }) => {
            requests.push(action);
            if (action === 'hqplayer-component-install') { installed = true; return status(); }
            if (action === 'hqplayer-component-uninstall') { installed = false; return status(); }
            if (action === 'hqplayer-status') return status();
            if (action === 'hqplayer-shutdown') { await new Promise(resolve => setTimeout(resolve, 100)); return { ok: true }; }
            if (action === 'hqplayer-launch-options') return { ok: true };
            throw new Error(`Unexpected action ${action}`);
        } } } });
    });
    await mount('hqplayerComponent');
    const card = page.getByTestId('hqplayer-component');
    await expect(card).toContainText('未安装');
    await page.getByRole('button', { name: '安装 / 更新 HQPlayer 组件', exact: true }).click();
    await expect(card).toContainText('0.1.0');
    await page.getByRole('button', { name: '使用 HQPlayer 输出', exact: true }).click();
    await expect(page.getByRole('button', { name: '停用 HQPlayer 组件', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '返回浏览器播放', exact: true }).click();
    await page.getByRole('button', { name: '停用 HQPlayer 组件', exact: true }).click();
    await expect(card).toContainText('未安装');
    await expect(page.getByRole('button', { name: '回退 HQPlayer 组件', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__componentRequests.some((action: string) => action.startsWith('component-')))).toBe(false);
    await page.screenshot({ path: 'test-results/hqplayer-independent-component.png' });
});
