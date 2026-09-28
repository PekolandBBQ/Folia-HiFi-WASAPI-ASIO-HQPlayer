const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// test/manual/exclusiveReleaseSmoke.cjs — inspect the actual fork executable in its own profile.
async function main() {
    const output = path.resolve('test-results/exclusive-release'); fs.mkdirSync(output, { recursive: true });
    const executablePath = path.resolve('release/0.7.9-exclusive.1-hifi/win-unpacked/Folia Exclusive HiFi.exe');
    const app = await _electron.launch({ executablePath, timeout: 60000 });
    const results = [];
    try {
        const page = await app.firstWindow(); page.setDefaultTimeout(15000);
        await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.electron?.nativeAudio);
        const host = await app.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), packaged: app.isPackaged, profile: app.getPath('userData') }));
        assert.equal(host.version, '0.7.9-exclusive.1'); assert.equal(host.name, 'Folia Exclusive HiFi');
        assert.equal(host.packaged, true); assert.equal(path.basename(host.profile), 'FoliaExclusive');
        results.push({ id: 'packaged-identity-and-isolated-profile', status: 'PASS' });
        let status = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
        if (!status.available) { await page.evaluate(() => window.electron.nativeAudio.request({action:'component-install'})); status=await page.evaluate(() => window.electron.nativeAudio.request({action:'status'})); }
        assert.equal(status.available, true); assert.equal(status.version, '0.1.2'); assert.equal(status.rollbackAvailable, true);
        results.push({ id: 'bundled-component-ready-with-rollback', status: 'PASS' });
        await page.evaluate(() => {
            localStorage.setItem('i18nextLng', 'zh-CN');
            localStorage.setItem('folia_native_audio_backend', 'browser');
            localStorage.setItem('folia_native_audio_processing_mode', 'compatibility');
            localStorage.setItem('folia_show_audio_signal_path', 'false');
            localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.9');
            localStorage.setItem('folia_last_seen_guide_version', '0.7.9');
        });
        await page.reload(); await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && window.electron?.nativeAudio);
        await page.waitForFunction(() => {
            const root=document.querySelector('#root'), key=Object.keys(root).find(k=>k.startsWith('__reactContainer'));
            const visit=f=>f&&(f.memoizedProps?.onPlaySong || visit(f.child) || visit(f.sibling));
            return !!visit(root[key]?.stateNode?.current);
        });
        await page.keyboard.press('Control+k');
        if (!await page.getByRole('combobox').isVisible()) { await page.waitForTimeout(500); if (!await page.getByRole('combobox').isVisible()) await page.keyboard.press('Control+k'); }
        await page.getByRole('combobox').fill('WASAPI');
        await page.getByRole('button', { name: /WASAPI及ASIO独占播放/ }).click();
        const section = page.locator('#settings-nativeAudioOutput');
        await section.getByRole('switch', { name: '整数直通（实验性）', exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('#settings-nativeAudioOutput [role="switch"]').disabled);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(output, 'settings.png') });
        await section.getByRole('button', { name: 'WASAPI及ASIO独占播放', exact: true }).click();
        const names = await page.getByRole('option').allTextContents(); assert.ok(names.some(n => n.includes('WASAPI'))); assert.ok(names.some(n => n.includes('ASIO')));
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(output, 'devices.png') });
        await page.getByRole('option').filter({ hasText: '浏览器音频' }).click();
        results.push({ id: 'renamed-settings-and-real-device-enumeration', status: 'PASS' });
        await section.getByRole('button', { name: '停用组件', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#settings-nativeAudioOutput [role="switch"]').disabled);
        for (const backend of ['WASAPI', 'ASIO']) {
            await section.getByRole('button', { name: 'WASAPI及ASIO独占播放', exact: true }).click();
            await page.getByRole('option').filter({ hasText: backend }).first().click();
            const dialog = page.locator('[data-folia-keyboard-window]:not([data-ponder-page-scope])').last();
            await dialog.waitFor(); await page.waitForTimeout(400);
            assert.match(await dialog.innerText(), /请先安装/);
            assert.equal(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend')), 'browser');
            if (backend === 'ASIO') await page.screenshot({ path: path.join(output, 'component-required.png') });
            await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
            results.push({ id: 'missing-component-' + backend, status: 'PASS' });
        }
        const hq = page.locator('#settings-hqPlayerOutput'); await hq.scrollIntoViewIfNeeded();
        const detected = await page.evaluate(() => window.electron.nativeAudio.request({action:'hqplayer-status'})); assert.ok(detected.executablePath);
        await app.evaluate(({ dialog }, executable) => { dialog.__reviewOpen = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [executable] }); }, detected.executablePath);
        await hq.getByRole('button', { name: '选择程序路径…', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="hqplayer-program-path"]')?.textContent.includes('自定义程序路径'));
        assert.equal((await page.evaluate(() => window.electron.nativeAudio.request({action:'hqplayer-status'}))).custom, true);
        await hq.getByRole('button', { name: '恢复自动检测', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="hqplayer-program-path"]')?.textContent.includes('自动检测的程序'));
        await app.evaluate(({ dialog }) => { dialog.showOpenDialog = dialog.__reviewOpen; delete dialog.__reviewOpen; });
        results.push({ id:'real-HQPlayer-path-selection-reset-dialog-result-stubbed', status:'PASS' });
        await hq.getByRole('button', { name: '使用 HQPlayer 输出', exact: true }).click();
        await page.waitForFunction(() => localStorage.getItem('folia_native_audio_backend') === 'hqplayer');
        await page.screenshot({ path: path.join(output, 'hqplayer.png') });
        await hq.getByRole('button', { name: '返回浏览器播放', exact: true }).click();
        results.push({ id: 'HQPlayer-selection-with-native-component-disabled', status: 'PASS' });
        await section.scrollIntoViewIfNeeded();
        await section.getByRole('switch', { name: '整数直通（实验性）', exact: true }).click();
        const dialog = page.locator('[data-folia-keyboard-window]:not([data-ponder-page-scope])').last();
        await dialog.getByRole('button', { name: '安装／更新组件', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
        status = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' })); assert.equal(status.available, true);
        results.push({ id: 'install-from-dependent-setting-prompt', status: 'PASS' });
        for (const name of ['整数直通（实验性）', '显示音频链路']) {
            const toggle = section.getByRole('switch', { name, exact: true });
            await toggle.click(); await page.waitForFunction(label => document.querySelector(`[aria-label="${label}"][role="switch"]`)?.getAttribute('aria-checked') === 'true', name);
            await toggle.click(); results.push({ id: 'installed-setting-' + name, status: 'PASS' });
        }
        const format = { release: host.version, packaged: host.packaged, profileName: path.basename(host.profile), rendererProtocol: new URL(page.url()).protocol, results };
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(format, null, 2)); console.log(JSON.stringify(format));
    } catch(error) { const page=await app.firstWindow(); await page.screenshot({path:path.join(output,'failure.png')}); fs.writeFileSync(path.join(output,'failure.txt'),await page.locator('body').innerText()); throw error; } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
