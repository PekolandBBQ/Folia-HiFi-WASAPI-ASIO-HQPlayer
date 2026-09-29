const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Explicit real-file playback through the packaged Electron IPC and external HQPlayer component.
async function main() {
    const [executable, source, output] = process.argv.slice(2).map(value => path.resolve(value));
    const silent = process.argv.includes('--silent');
    fs.mkdirSync(output, { recursive: true });
    const app = await _electron.launch({ executablePath: executable, timeout: 60000 });
    const result = {};
    let page;
    try {
        page = await app.firstWindow();
        await page.waitForFunction(() => window.electron?.nativeAudio && document.querySelector('#root')?.children.length);
        const started = Date.now();
        result.loaded = await page.evaluate(async ({ source, silent }) => {
            const api = window.electron.nativeAudio;
            window.__localEvents = []; api.onEvent(event => window.__localEvents.push(event));
            await api.request({ action: 'begin', session: 'local-final', backend: 'hqplayer', deviceId: 'hqplayer-local',
                path: source, trackKey: 'local-final', hqplayerGainDb: -35, silent });
            const loaded = await api.request({ action: 'finish', session: 'local-final' });
            await api.request({ action: 'volume', session: 'local-final', volume: 1 });
            await api.request({ action: 'play', session: 'local-final' });
            return loaded;
        }, { source, silent });
        result.loadAndStartMs = Date.now() - started;
        await page.waitForFunction(() => window.__localEvents.some(event => event.state?.playing && event.state.position > 2), null, { timeout: 30000 });
        result.playing = await page.evaluate(() => window.__localEvents.filter(event => event.state).at(-1).state);
        result.windows = require('./hqplayerWindowState.cjs').hqplayerWindowState();
        assert.equal(result.windows.pids.length, 1);
        assert.equal(result.windows.windows.some(window => window.visible && !window.minimized), !silent);
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-shutdown' }));
        result.remainingHQPlayers = (await require('../../../folia-hqplayer-component/src/hqplayerInstance.cjs').findRunningHQPlayers()).length;
        assert.equal(result.remainingHQPlayers, 0);
        await page.keyboard.press('Control+k');
        await page.getByRole('combobox').fill('HQPlayer');
        await page.getByRole('button', { name: /HQPlayer Desktop/ }).click();
        const switches = ['后台静默开启 HQPlayer', '记忆在 HQPlayer 中调整的增益', '显示音频链路'];
        result.switches = [];
        for (const name of switches) {
            const control = page.locator('#settings-hqPlayerOutput').getByRole('switch', { name, exact: true });
            await control.scrollIntoViewIfNeeded();
            result.switches.push({ name, role: await control.getAttribute('role'), checked: await control.getAttribute('aria-checked') });
        }
        await page.screenshot({ path: path.join(output, 'packaged-settings-switches.png') });
        result.status = 'PASS';
    } catch (error) { result.status = 'FAIL'; result.error = error.message; throw error; }
    finally {
        if (page) await page.evaluate(() => window.electron.nativeAudio.request({ action: 'hqplayer-shutdown' })).catch(() => {});
        await app.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
