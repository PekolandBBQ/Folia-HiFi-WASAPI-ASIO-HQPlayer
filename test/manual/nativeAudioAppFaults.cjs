const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createComponentManager } = require('../../electron/nativeAudio/componentManager.cjs');

// test/manual/nativeAudioAppFaults.cjs — fault injection is restricted to the isolated review profile's child.
function driverProcess() {
    const list = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='folia-audio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8' }) || '[]');
    const prefix = path.join(process.env.LOCALAPPDATA, 'FoliaNativeReview', 'profile', 'components', 'native-audio') + path.sep;
    const candidates = (Array.isArray(list) ? list : [list]).filter(p => p.ExecutablePath?.startsWith(prefix));
    if (candidates.length !== 1) throw new Error('Expected exactly one isolated review driver');
    return candidates[0].ProcessId;
}
function suspendDriver(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid driver PID');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReviewSuspend { [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }';
$taskHandle = [ReviewSuspend]::OpenProcess(0x0800, $false, ${pid});
if ($taskHandle -eq [IntPtr]::Zero) { throw 'Cannot open isolated driver' }
try { if ([ReviewSuspend]::NtSuspendProcess($taskHandle) -ne 0) { throw 'Cannot suspend isolated driver' } } finally { [void][ReviewSuspend]::CloseHandle($taskHandle) }
`], { encoding: 'utf8' });
}
async function runFaultReview(page, record) {
    await page.evaluate(() => {
        const r = window.__appReview; r.active()?.pause(); r.settings.getState().handleSetNativeAudioOutput('browser', '');
    });
    await page.waitForTimeout(300);
    await record('rollback-stage', '在隔离配置中准备真实旧版和新版组件', 'Stage two verified real versions in the isolated profile', async () => {
        const profile = path.join(process.env.LOCALAPPDATA, 'FoliaNativeReview', 'profile');
        const catalog = JSON.parse(await fs.readFile('../folia-native-audio-component/artifacts/development-catalog.json', 'utf8'));
        const previous = catalog.releases.find(r => r.version === '0.1.0');
        if (!previous) throw new Error('Missing previous archive');
        const catalogPath = path.join(process.env.LOCALAPPDATA, 'FoliaNativeReview', 'rollback-test-catalog.json');
        await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [previous, ...catalog.releases.filter(r => r !== previous)] }));
        await createComponentManager({ app: { isPackaged: false, getPath: () => profile }, catalogPath }).install();
        await page.evaluate(() => window.electron.nativeAudio.request({ action: 'component-install' }));
        const state = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
        if (!state.rollbackAvailable || state.version !== catalog.releases[0].version) throw new Error('Rollback staging failed');
        return { currentVersion: state.version, rollbackAvailable: state.rollbackAvailable };
    });
    for (const backend of ['wasapi-exclusive', 'asio']) for (const choice of ['auto-crash', 'auto-timeout', 'retry', 'browser', 'rollback']) {
        await record(`${backend}-real-fault-${choice}`, '真实组件故障后的 App 恢复', 'App recovery after a real component fault', async () => {
            await page.evaluate(async ({ backend, choice }) => {
                const r = window.__appReview;
                r.settings.getState().handleSetNativeAudioAutoFallback(choice.startsWith('auto-'));
                r.settings.getState().handleSetNativeAudioOutput(backend, r.devices.find(d => d.backend === backend).id);
                await new Promise(resolve => setTimeout(resolve, 100));
                await r.playEntry()(r.song, [r.song], false, { shouldNavigateToPlayer: false });
            }, { backend, choice });
            await page.waitForFunction(() => { const t = window.__appReview.active(); return t?.readyState === 4 && !t.paused && t.currentTime > .2; }, { timeout: 25000 });
            await page.evaluate(() => { window.__appReview.active().currentTime = 3; });
            await page.waitForFunction(() => { const t = window.__appReview.active(); return !t.seeking && t.currentTime >= 3; });
            const pid = driverProcess(), start = Date.now();
            try {
                if (choice === 'auto-timeout') {
                    suspendDriver(pid);
                    await page.evaluate(() => { const t = window.__appReview.active(); t.volume = .1; });
                } else process.kill(pid);
                if (!choice.startsWith('auto-')) {
                    await page.getByRole('alert').filter({ hasText: /组件|component/i }).waitFor();
                    await record(`${backend}-real-dialog-${choice}`, '实际故障提示和三种选择', 'Actual failure dialog and three choices', async () => ({ error: 'COMPONENT_CRASHED' }));
                    const label = await page.evaluate(async choice => (await import('/src/i18n/config.ts')).default.t(`nativeAudio.recovery.${choice}`), choice);
                    await page.getByRole('button', { name: label, exact: true }).click();
                }
                const web = choice.startsWith('auto-') || choice === 'browser';
                await page.waitForFunction(web => {
                    const r = window.__appReview;
                    const media = web ? [...document.querySelectorAll('audio')].find(a => !a.paused && a.currentTime >= 2.8) : r.active();
                    return media && !media.paused && media.currentTime >= 2.8 && r.playback.getState().playerState === 'PLAYING'
                        && (web ? r.settings.getState().nativeAudioBackend === 'browser' && r.settings.getState().nativeAudioDeviceId === '' : !media.error);
                }, web, { timeout: 30000 });
                const state = await page.evaluate(web => {
                    const r = window.__appReview, media = web ? [...document.querySelectorAll('audio')].find(a => !a.paused) : r.active();
                    return { backend: r.settings.getState().nativeAudioBackend, position: media.currentTime, playerState: r.playback.getState().playerState,
                        sameSong: r.getPlaybackSongKey(r.playback.getState().currentSong) === r.getPlaybackSongKey(r.song) };
                }, web);
                if (!state.sameSong) throw new Error('Recovery skipped the current track');
                const component = await page.evaluate(() => window.electron.nativeAudio.request({ action: 'status' }));
                if (choice === 'rollback' && component.version !== '0.1.0') throw new Error('Previous component not activated');
                return { ...state, componentVersion: component.version, recoveryMs: Date.now() - start, fault: choice === 'auto-timeout' ? 'suspended-real-process-and-RPC' : 'terminated-real-process' };
            } finally {
                // Kill only a suspended test driver if timeout recovery itself failed.
                if (choice === 'auto-timeout') try { process.kill(pid); } catch { /* Already terminated. */ }
                await page.evaluate(() => {
                    const r = window.__appReview; r.active()?.pause();
                    document.querySelectorAll('audio').forEach(a => a.pause());
                    r.settings.getState().handleSetNativeAudioOutput('browser', '');
                });
                await page.waitForTimeout(200);
                if (choice === 'rollback') await page.evaluate(() => window.electron.nativeAudio.request({ action: 'component-install' }));
            }
        });
    }
    await page.evaluate(() => window.__appReview.settings.getState().handleSetNativeAudioAutoFallback(true));
}
module.exports = { runFaultReview };
