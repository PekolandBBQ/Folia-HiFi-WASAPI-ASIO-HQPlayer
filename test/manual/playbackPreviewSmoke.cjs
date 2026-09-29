const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const findRunningHQPlayers = async () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | Select-Object Id) -Compress"], { encoding: 'utf8', windowsHide: true }));

// Inspect the packaged preview itself. No Play command or audio-device change is issued.
async function main() {
    const executablePath = path.resolve(process.argv[2]);
    const output = path.resolve(process.argv[3]);
    await fs.mkdir(output, { recursive: true });
    const app = await _electron.launch({ executablePath, timeout: 60000 });
    const errors = [];
    try {
        const page = await app.firstWindow(); page.setDefaultTimeout(20000);
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => document.querySelector('#root')?.children.length && window.electron?.nativeAudio);
        const identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), packaged: app.isPackaged, profile: app.getPath('userData') }));
        assert.equal(identity.version, '0.7.9-preview.20260930.2');
        assert.equal(identity.name, 'Folia-HiFi-Preview'); assert.equal(identity.packaged, true);
        assert.equal(path.basename(identity.profile), 'Folia HiFi Preview');
        const defaults = await page.evaluate(() => ({ compatibility: localStorage.getItem('folia_decode_compatibility'), silent: localStorage.getItem('folia_hqplayer_silent_launch') }));
        assert.notEqual(defaults.compatibility, 'true'); assert.notEqual(defaults.silent, 'true');
        const component = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
        assert.equal(component.available, true); assert.equal(component.rollbackAvailable, true);
        const hqplayer = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-status' }));
        assert.equal(hqplayer.available, true);
        assert.equal(hqplayer.component.version, '0.1.0');
        // Disabling either slot must leave the other one available and unchanged.
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-component-uninstall' }));
        assert.equal((await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }))).available, true);
        assert.equal((await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-status' }))).component.available, false);
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-component-install' }));
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'component-uninstall' }));
        assert.equal((await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-status' }))).component.available, true);
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'component-install' }));
        await page.evaluate(() => {
            localStorage.setItem('i18nextLng', 'zh-CN');
            localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.9');
            localStorage.setItem('folia_last_seen_guide_version', '0.7.9');
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#root')?.children.length && !document.querySelector('#app-splash'));
        await page.keyboard.press('Control+k');
        await page.getByRole('combobox').fill('WASAPI');
        await page.getByRole('button', { name: /WASAPI及ASIO独占播放/ }).click();
        const compatibility = page.getByRole('switch', { name: '兼容模式', exact: true });
        await compatibility.scrollIntoViewIfNeeded(); assert.equal(await compatibility.isChecked(), false);
        await page.screenshot({ path: path.join(output, 'packaged-compatibility.png') });
        const silent = page.getByRole('switch', { name: '后台静默开启 HQPlayer', exact: true });
        await silent.scrollIntoViewIfNeeded(); assert.equal(await silent.isChecked(), false);
        await page.screenshot({ path: path.join(output, 'packaged-hqplayer.png') });
        let liveDsp = 'skipped-existing-external-instance';
        if (!(await findRunningHQPlayers()).length) {
            await page.getByRole('button', { name: '使用 HQPlayer 输出', exact: true }).click();
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'HQPlayer 升频设置', exact: true }).click();
            const mode = page.getByLabel('升频模式', { exact: true });
            await mode.waitFor({ timeout: 35000 });
            assert.ok(await mode.locator('option').count() >= 2);
            assert.ok(await page.getByLabel('滤波器', { exact: true }).locator('option').count() > 1);
            assert.equal(await page.getByRole('button', { name: '应用到当前歌曲', exact: true }).isDisabled(), true);
            assert.equal((await findRunningHQPlayers()).length, 1);
            await page.screenshot({ path: path.join(output, 'packaged-live-dsp.png') });
            liveDsp = 'PASS-idle-controls-real-catalog-single-instance-no-audio';
            await page.evaluate(() => localStorage.setItem('folia_native_audio_backend', 'browser'));
        }
        assert.deepEqual(errors, []);
        const result = { identity, defaults, component, hqplayer, liveDsp, rendererErrors: errors, status: 'PASS' };
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } catch (error) {
        const page = await app.firstWindow();
        await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
        await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'No renderer'));
        throw error;
    } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
