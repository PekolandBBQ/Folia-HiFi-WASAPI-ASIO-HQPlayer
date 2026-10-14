import { test, expect } from './fixtures';

// test/component/nativeAudio.spec.ts — validates StrictMode and real settings controls in Chromium.
test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) await page.screenshot({ path: testInfo.outputPath('failure.png') });
});
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_native_audio_backend', 'wasapi-exclusive');
        localStorage.setItem('folia_native_audio_device', 'wasapi-device');
        let state = { session: '', position: 0, duration: 10, playing: false, ended: false,
            sourceSampleRate: 96000, sourceBitsPerSample: 24, sourceCodec: 'FLAC', effectiveGain: 0.5, outputFormat: 'PCM32 integer direct',
            sampleRate: 96000, channels: 2, latency: 0.02, backend: 'wasapi-exclusive', deviceId: 'wasapi-device' };
        const listeners = new Set<(value: unknown) => void>();
        const requests: Array<Record<string, unknown>> = [];
        const component = { available: true, installed: true, installable: true, failInstall: false };
        Object.assign(window, { __nativeRequests: requests, __nativeComponent: component,
            __nativeFailure: (errorCode: string) => listeners.forEach(listener => listener({ event: 'error', session: state.session, errorCode })),
            electron: {
            get platform() { return localStorage.getItem('native_probe_platform') || 'win32'; },
            webUtils: { getPathForFile: () => 'C:\\fixture.flac' },
            nativeAudio: {
                get supported() { return localStorage.getItem('native_probe_supported') !== 'false'; },
                onEvent: (listener: (value: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
                request: async (request: Record<string, unknown>) => {
                    requests.push(request);
                    if (request.action === 'hqplayer-launch-options') return { ok: true };
                    if (request.action === 'component-rollback') return { ok: true };
                    if (request.action === 'hqplayer-status') return { available: localStorage.getItem('hqplayer_installed') === 'true' || Boolean(localStorage.getItem('hqplayer_mock_path')), custom: Boolean(localStorage.getItem('hqplayer_mock_path')), executablePath: localStorage.getItem('hqplayer_mock_path') || '' };
                    if (request.action === 'hqplayer-select-executable') {
                        if (localStorage.getItem('hqplayer_mock_cancel') === 'true') return { canceled: true };
                        localStorage.setItem('hqplayer_mock_path', 'C:/HQPlayer 5 Desktop/HQPlayer5Desktop.exe');
                        return { canceled: false, available: true, custom: true, executablePath: localStorage.getItem('hqplayer_mock_path') };
                    }
                    if (request.action === 'hqplayer-reset-executable') { localStorage.removeItem('hqplayer_mock_path'); return { canceled: false, available: false, custom: false }; }
                    if (request.action === 'status') {
                        const reply = (window as unknown as { __nativeStatusReply?: () => Promise<unknown> }).__nativeStatusReply;
                        if (reply) return reply();
                        await (window as unknown as { __nativeStatusGate?: () => Promise<void> }).__nativeStatusGate?.();
                        return { supported: true, ...component, version: component.installed ? '0.1.0' : undefined };
                    }
                    if (request.action === 'component-uninstall') { component.available = false; component.installed = false; return { ok: true }; }
                    if (request.action === 'component-install') {
                        if (component.failInstall) throw Object.assign(new Error('private diagnostic'), { code: 'COMPONENT_UPDATE_FAILED' });
                        component.available = true; component.installed = true; return { ok: true };
                    }
                    if (request.action === 'devices') {
                        const probe = window as unknown as { __nativeDevicesGate?: () => Promise<void>;
                            __nativeDevicesFixture?: { fail?: boolean; devices?: unknown[] } };
                        await probe.__nativeDevicesGate?.();
                        if (probe.__nativeDevicesFixture?.fail) throw Object.assign(new Error('enumeration fixture failure'), { code: 'NATIVE_REQUEST_FAILED' });
                        return probe.__nativeDevicesFixture?.devices || [
                            { backend: 'wasapi-exclusive', id: 'wasapi-device', name: 'Test DAC' },
                            { backend: 'asio', id: 'asio-device', name: 'Test ASIO Driver' },
                        ];
                    }
                    if (request.action === 'begin') state = { ...state, session: String(request.session),
                        position: 0, playing: false, backend: String(request.backend), deviceId: String(request.deviceId) };
                    if (request.session !== state.session) throw new Error('Stale session');
                    if (request.action === 'play') state.playing = true;
                    if (request.action === 'pause' || request.action === 'stop') state.playing = false;
                    if (request.action === 'seek') state.position = Number(request.position);
                    return { ...state };
                },
            },
        } });
        setInterval(() => {
            if (!state.playing) return;
            state.position += 0.04;
            listeners.forEach(listener => listener({ event: 'state', session: state.session, state: { ...state } }));
        }, 40);
    });
});



// Component availability precedes asynchronous device discovery. Absence is known only after success.
const noAsioDescription = "No x64 ASIO driver found. Install the audio interface manufacturer's driver to use ASIO.";

// Hold the two actual StrictMode status requests independently; late results must not change the latest view.
for (const scenario of ['older-unavailable', 'newer-unavailable', 'older-finishes-first'] as const) {
    test(`overlapping device discovery preserves the latest request: ${scenario}`, async ({ mount, page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('folia_app_language', 'en'); localStorage.setItem('folia_native_audio_backend', 'browser');
            const replies: Array<(value: unknown) => void> = [];
            Object.assign(window, { __nativeStatusReply: () => new Promise(resolve => replies.push(resolve)),
                __releaseNativeStatus: (index: number, available: boolean) => replies[index]({ supported: true,
                    available, installed: true, version: '0.1.0', errorCode: available ? undefined : 'COMPONENT_UNAVAILABLE' }) });
        });
        await mount('nativeAudio');
        await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((request: any) => request.action === 'status').length)).toBe(2);
        const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
        const refresh = section.getByRole('button', { name: 'Refresh audio devices', exact: true });
        if (scenario === 'older-finishes-first') {
            await page.evaluate(() => (window as any).__releaseNativeStatus(0, true));
            // A later page task lets the completed older promise settle without a timing sleep.
            await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
            await expect(refresh).toBeDisabled();
            await expect(section).not.toContainText(noAsioDescription);
            await page.evaluate(() => (window as any).__releaseNativeStatus(1, true));
            await expect(refresh).toBeEnabled();
        } else {
            await page.evaluate(available => (window as any).__releaseNativeStatus(1, available), scenario === 'older-unavailable');
            await expect(refresh).toBeEnabled();
            if (scenario === 'newer-unavailable') await expect(section.getByRole('alert')).toBeVisible();
            await page.evaluate(available => (window as any).__releaseNativeStatus(0, available), scenario === 'newer-unavailable');
            await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
            if (scenario === 'newer-unavailable') {
                await expect(section.getByRole('alert')).toBeVisible();
                await expect(section).not.toContainText(noAsioDescription);
            } else {
                await expect(section.getByRole('alert')).toHaveCount(0);
                await section.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
                await expect(page.getByRole('option', { name: 'ASIO — Test ASIO Driver', exact: true })).toBeVisible();
            }
        }
        expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
    });
}
test('late device enumeration never reports a missing ASIO driver before the actual ASIO list arrives', async ({ mount, page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_app_language', 'en'); localStorage.setItem('folia_native_audio_backend', 'browser');
        const waiting: Array<() => void> = [];
        Object.assign(window, { __nativeDevicesGate: () => new Promise<void>(resolve => waiting.push(resolve)),
            __releaseNativeDevices: () => { delete (window as any).__nativeDevicesGate; waiting.splice(0).forEach(resolve => resolve()); } });
    });
    await mount('nativeAudio');
    const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
    await expect(section).toContainText('v0.1.0');
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((request: any) => request.action === 'devices').length)).toBeGreaterThan(0);
    await expect(section.getByRole('button', { name: 'Refresh audio devices', exact: true })).toBeDisabled();
    await expect(section).not.toContainText(noAsioDescription);
    await page.evaluate(() => (window as any).__releaseNativeDevices());
    await expect(section.getByRole('button', { name: 'Refresh audio devices', exact: true })).toBeEnabled();
    await section.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
    await expect(page.getByRole('option', { name: 'ASIO — Test ASIO Driver', exact: true })).toBeVisible();
    await expect(section).not.toContainText(noAsioDescription);
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
});
test('failed first device enumeration is unknown rather than proof of no ASIO driver', async ({ mount, page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_app_language', 'en'); localStorage.setItem('folia_native_audio_backend', 'browser');
        Object.assign(window, { __nativeDevicesFixture: { fail: true } });
    });
    await mount('nativeAudio');
    const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
    await expect(section.getByRole('button', { name: 'Refresh audio devices', exact: true })).toBeEnabled();
    await expect(section.getByRole('alert')).toBeVisible();
    await expect(section).not.toContainText(noAsioDescription);
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
});
test('a failed refresh retains prior devices but withdraws the unconfirmed no-ASIO assertion', async ({ mount, page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_app_language', 'en'); localStorage.setItem('folia_native_audio_backend', 'browser');
        Object.assign(window, { __nativeDevicesFixture: { devices: [{ backend: 'wasapi-exclusive', id: 'wasapi-device', name: 'Test DAC' }] } });
    });
    await mount('nativeAudio');
    const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
    await expect(section).toContainText(noAsioDescription);
    const refresh = section.getByRole('button', { name: 'Refresh audio devices', exact: true });
    await expect(refresh).toBeEnabled();
    await page.evaluate(() => {
        const waiting: Array<() => void> = [];
        Object.assign(window, { __nativeDevicesFixture: { fail: true },
            __nativeDevicesGate: () => new Promise<void>(resolve => waiting.push(resolve)),
            __releaseNativeDevices: () => { delete (window as any).__nativeDevicesGate; waiting.splice(0).forEach(resolve => resolve()); } });
    });
    await refresh.click(); await expect(refresh).toBeDisabled();
    await expect(section).not.toContainText(noAsioDescription);
    await page.evaluate(() => (window as any).__releaseNativeDevices());
    await expect(refresh).toBeEnabled(); await expect(section.getByRole('alert')).toBeVisible();
    await expect(section).not.toContainText(noAsioDescription);
    await section.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
    await expect(page.getByRole('option', { name: 'WASAPI exclusive — Test DAC', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((request: any) => request.action === 'begin' || request.action === 'component-install').length)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
});

// A held status response reproduces the real first-open interval without arbitrary sleeps.
for (const [language, checking, pending, required, title] of [
    ['en', 'Checking native audio component…', 'No component release is approved in this build yet.', 'Install and enable the native audio component before selecting a device', 'WASAPI / ASIO exclusive playback'],
    ['zh-CN', '正在检查原生音频组件…', '此构建尚未配置已审核的组件发布。', '请先安装并启用原生音频组件', 'WASAPI及ASIO独占播放'],
    ['in', 'Memeriksa komponen audio asli…', 'Belum ada rilis komponen yang disetujui.', 'Instal dan aktifkan komponen audio asli sebelum memilih perangkat', 'Pemutaran eksklusif WASAPI / ASIO'],
]) test(language + ' waits for component status without presenting a false installation failure', async ({ mount, page }) => {
    await page.addInitScript(language => {
        localStorage.setItem('folia_native_audio_backend', 'browser');
        localStorage.setItem('folia_app_language', language);
        const waiting: Array<() => void> = [];
        Object.assign(window, { __nativeStatusGate: () => new Promise<void>(resolve => waiting.push(resolve)),
            __releaseNativeStatus: () => { delete (window as any).__nativeStatusGate; waiting.splice(0).forEach(resolve => resolve()); } });
    }, language);
    await mount('nativeAudio');
    const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
    await expect(section.locator('p[role="status"]')).toHaveText(checking);
    await expect(section).not.toContainText(pending);
    await expect(section).not.toContainText(required);
    await expect(section.getByRole('button', { name: title, exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((request: any) => request.action === 'status').length)).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__releaseNativeStatus());
    await expect(section).toContainText('v0.1.0');
    await expect(section.locator('p[role="status"]')).toHaveCount(0);
    await expect(section.getByRole('button', { name: title, exact: true })).toBeEnabled();
    await expect(section).not.toContainText(pending);
    await expect(section).not.toContainText(required);
    await section.getByRole('button', { name: title, exact: true }).click();
    await expect(page.getByRole('option', { name: 'ASIO — Test ASIO Driver', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((request: any) => request.action === 'component-install' || request.action === 'begin').length)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
});

test('a delayed unavailable result retains installation guidance and protects the current output', async ({ mount, page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_native_audio_backend', 'browser');
        const waiting: Array<() => void> = [];
        Object.assign(window, { __nativeStatusGate: () => new Promise<void>(resolve => waiting.push(resolve)),
            __releaseNativeStatus: () => {
                Object.assign((window as any).__nativeComponent, { available: false, installed: false, installable: true });
                delete (window as any).__nativeStatusGate; waiting.splice(0).forEach(resolve => resolve());
            } });
    });
    await mount('nativeAudio');
    const section = page.locator('[data-settings-anchor="nativeAudioOutput"]');
    await expect(section.locator('p[role="status"]')).toHaveText('Checking native audio component…');
    await expect(section).not.toContainText('Install and enable the native audio component before selecting a device');
    await page.evaluate(() => (window as any).__releaseNativeStatus());
    await expect(section.locator('p[role="status"]')).toHaveCount(0);
    await expect(section).toContainText('Install and enable the native audio component before selecting a device');
    await expect(section).not.toContainText('No component release is approved in this build yet.');
    await section.getByRole('switch', { name: 'Show audio signal path', exact: true }).click();
    const dialog = page.locator('[data-folia-keyboard-window]');
    await expect(dialog.getByRole('heading', { name: 'Native audio component required' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Install / update component', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
    await expect(section.getByRole('switch', { name: 'Show audio signal path' })).toHaveAttribute('aria-checked', 'false');
});

for (const target of ['WASAPI exclusive — Test DAC', 'ASIO — Test ASIO Driver',
    'Integer direct (experimental)', 'Show audio signal path', 'Automatically return to Web playback on component crash or timeout']) {
    test(`uninstalled component explains the requirement without changing ${target}`, async ({ mount, page }) => {
        await page.addInitScript(() => localStorage.setItem('folia_native_audio_backend', 'browser'));
        await mount('nativeAudio');
        await page.getByRole('button', { name: 'Disable component', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Install / update component', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect(page.getByTestId('status')).toHaveText('playing');
        const before = await page.evaluate(() => ({ ...localStorage }));
        if (target.includes(' — ')) {
            await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
            await page.getByRole('option', { name: target, exact: true }).click();
        } else await page.getByRole('switch', { name: target, exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Native audio component required' })).toBeVisible();
        const dialog = page.locator('[data-folia-keyboard-window]');
        await expect(dialog.getByRole('alert')).toContainText('Install');
        await expect(dialog.getByRole('button', { name: 'Install / update component' })).toBeEnabled();
        await expect(dialog).toHaveCSS('opacity', '1');
        await expect(dialog.locator(':scope > div')).toHaveCSS('opacity', '1');
        await expect(page.getByTestId('status')).toHaveText('playing');
        const after = await page.evaluate(() => ({ ...localStorage }));
        for (const key of ['folia_native_audio_backend', 'folia_native_audio_device', 'folia_native_audio_processing_mode', 'folia_show_audio_signal_path', 'folia_native_audio_auto_fallback'])
            expect(after[key]).toBe(before[key]);
        await page.screenshot({ path: `test-results/component-required-${target.startsWith('ASIO') ? 'asio' : target.startsWith('WASAPI') ? 'wasapi' : target.split(' ')[0]}.png` });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Native audio component required' })).toHaveCount(0);
    });
}

test('installation prompt reports failure, permits retry, and unlocks settings after success', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_native_audio_backend', 'browser'));
    await mount('nativeAudio');
    await page.getByRole('button', { name: 'Disable component', exact: true }).click();
    await page.getByRole('switch', { name: 'Integer direct (experimental)' }).click();
    const dialog = page.locator('[data-folia-keyboard-window]');
    await page.evaluate(() => Object.assign((window as any).__nativeComponent, { failInstall: true }));
    await dialog.getByRole('button', { name: 'Install / update component' }).click();
    await expect(dialog.getByRole('alert')).toContainText('update failed');
    await expect(dialog).not.toContainText('private diagnostic');
    await page.evaluate(() => Object.assign((window as any).__nativeComponent, { failInstall: false }));
    await dialog.getByRole('button', { name: 'Install / update component' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('switch', { name: 'Integer direct (experimental)' }).click();
    await expect(page.getByRole('switch', { name: 'Integer direct (experimental)' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
    await page.getByRole('option', { name: 'ASIO — Test ASIO Driver', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('asio');
});

test('allows native component updates while the separate HQPlayer output remains selected', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_native_audio_backend', 'hqplayer'));
    await mount('nativeAudio');
    const install = page.getByRole('button', { name: 'Install / update component', exact: true });
    await expect(install).toBeEnabled(); await install.click();
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.some((r: any) => r.action === 'component-install'))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('hqplayer');
    await expect(page.getByRole('button', { name: 'Disable component', exact: true })).toBeEnabled();
});

test('rechecks cached availability and explains when no approved install is available', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_native_audio_backend', 'browser'));
    await mount('nativeAudio');
    await expect(page.getByRole('button', { name: 'Disable component', exact: true })).toBeVisible();
    await page.evaluate(() => Object.assign((window as any).__nativeComponent, { available: false, installed: false, installable: false }));
    await page.getByRole('switch', { name: 'Show audio signal path' }).click();
    const dialog = page.locator('[data-folia-keyboard-window]');
    await expect(dialog).toContainText('No component release is approved');
    await expect(dialog.getByRole('button', { name: 'Install / update component' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Show audio signal path' })).toHaveAttribute('aria-checked', 'false');
});

for (const platform of ['darwin', 'linux', 'win32']) {
    test(`hides dependent settings on ${platform === 'win32' ? 'unsupported Windows architecture' : platform}`, async ({ mount, page }) => {
        await page.addInitScript(platform => {
            localStorage.setItem('folia_native_audio_backend', 'browser');
            localStorage.setItem('native_probe_platform', platform);
            localStorage.setItem('native_probe_supported', platform === 'win32' ? 'false' : 'true');
        }, platform);
        await mount('nativeAudio', { hqplayer: true });
        await expect(page.getByRole('button', { name: 'Use HQPlayer output' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' })).toHaveCount(0);
        await expect(page.getByRole('switch', { name: 'Integer direct (experimental)' })).toHaveCount(0);
        await expect(page.getByRole('switch', { name: 'Show audio signal path' })).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__nativeRequests.length)).toBe(0);
    });
}

test('mount-time autoplay survives StrictMode layout replay without spending its intent twice', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('native_probe_autoplay', 'true'));
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect.poll(async () => Number(await page.getByTestId('clock').textContent())).toBeGreaterThan(.2);
    const requests = await page.evaluate(() => (window as unknown as { __nativeRequests: Array<{ action: string }> }).__nativeRequests);
    expect(requests.filter(r => r.action === 'play')).toHaveLength(1);
    expect(requests.filter(r => r.action === 'begin')).toHaveLength(1);
});

test('fatal crash defaults to browser fallback and clears the selected native output', async ({ mount, page }) => {
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.screenshot({ path: 'test-results/native-recovery-before-crash.png' });
    await page.evaluate(() => (window as unknown as { __nativeFailure: (code: string) => void }).__nativeFailure('COMPONENT_CRASHED'));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_device'))).toBe('');
    await expect(page.getByTestId('status')).toHaveText('playing');
    await page.screenshot({ path: 'test-results/native-recovery-browser.png' });
});

test('disabled automatic fallback offers three explicit recovery choices', async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_native_audio_auto_fallback', 'false'));
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.evaluate(() => (window as unknown as { __nativeFailure: (code: string) => void }).__nativeFailure('COMPONENT_TIMEOUT'));
    await expect(page.getByRole('alert')).toContainText('timed out');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to default playback', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try previous component version', exact: true })).toBeVisible();
    await expect(page.locator('[data-folia-keyboard-window]')).toHaveCSS('opacity', '1');
    await expect(page.locator('[data-folia-keyboard-window] > div')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'test-results/native-recovery-choices.png' });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/native-recovery-retry.png' });
});

for (const choice of ['browser', 'rollback']) test(`manual ${choice} recovery resumes playback`, async ({ mount, page }) => {
    await page.addInitScript(() => localStorage.setItem('folia_native_audio_auto_fallback', 'false'));
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.evaluate(() => (window as unknown as { __nativeFailure: (code: string) => void }).__nativeFailure('COMPONENT_CRASHED'));
    await page.getByRole('button', { name: choice === 'browser' ? 'Return to default playback' : 'Try previous component version', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (choice === 'rollback') await expect.poll(() => page.evaluate(() =>
        (window as unknown as { __nativeRequests: Array<{ action: string }> }).__nativeRequests.some(request => request.action === 'component-rollback'))).toBe(true);
    await page.screenshot({ path: `test-results/native-recovery-manual-${choice}.png` });
});

test('selects ASIO and preserves basic control and clock behavior through native deck remounts', async ({ mount, page }) => {
    await mount('nativeAudio');
    const card = page.locator('#settings-nativeAudioOutput > div').last();
    await expect(card).toHaveCSS('border-top-left-radius', '12px');
    await expect(card).toHaveCSS('border-bottom-right-radius', '12px');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('switch', { name: 'Integer direct (experimental)' }).click();
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_processing_mode')))
        .toBe('integer-direct');
    // A paused output handoff defers preparation until explicit Play.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
        const requests = (window as unknown as { __nativeRequests: Array<Record<string, unknown>> }).__nativeRequests;
        return requests.slice().reverse().find(request => request.action === 'begin')?.processingMode;
    })).toBe('integer-direct');
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect.poll(async () => Number(await page.getByTestId('clock').textContent())).toBeGreaterThan(0.1);
    await page.getByRole('button', { name: 'Seek 5s' }).click();
    await expect.poll(async () => Number(await page.getByTestId('clock').textContent())).toBeGreaterThanOrEqual(5);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('paused');
    await expect.poll(async () => page.evaluate(() =>
        (window as unknown as { __nativeRequests: Array<{ action: string }> }).__nativeRequests.at(-1)?.action)).toBe('pause');
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' }).click();
    await page.getByText('ASIO — Test ASIO Driver', { exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('paused');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('asio');
    await page.getByRole('button', { name: 'Next file' }).click();
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await page.screenshot({ path: 'test-results/native-audio-settings.png' });
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' }).click();
    await page.getByText('Browser audio (default)', { exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('paused');
});

test('switches a playing track between native outputs without another Play and retains a paused checkpoint', async ({ mount, page }) => {
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Seek 5s' }).click();
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' }).click();
    await page.getByText('ASIO — Test ASIO Driver', { exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect.poll(async () => Number(await page.getByTestId('clock').textContent())).toBeGreaterThanOrEqual(5);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' }).click();
    await page.getByText('WASAPI exclusive — Test DAC', { exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('paused');
    await expect.poll(async () => Number(await page.getByTestId('clock').textContent())).toBeGreaterThanOrEqual(5);
    const count = await page.evaluate(() => (window as any).__nativeRequests.filter((r: any) => r.action === 'play').length);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => (window as any).__nativeRequests.filter((r: any) => r.action === 'play').length)).toBe(count);
});


test('browser to native handoff uses listener volume rather than the media element unity gain', async ({ mount, page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('folia_native_audio_backend', 'browser');
        localStorage.setItem('player_volume', '0.18');
    });
    await mount('nativeAudio');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    // A browser Web Audio graph owns listener volume; the element itself stays at unity.
    await page.locator('audio').evaluate(audio => { (audio as HTMLAudioElement).volume = 1; });
    await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback' }).click();
    await page.getByText('WASAPI exclusive — Test DAC', { exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect.poll(() => page.evaluate(() => (window as any).__nativeRequests.filter((r: any) => r.action === 'volume').at(-1)?.volume)).toBe(0.18);
});

test('a rejected load shows a persistent failed signal path instead of preparing forever', async ({ mount, page }) => {
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('switch', { name: 'Show audio signal path' }).click();
    await page.evaluate(() => (window as any).__nativeFailure('HQPLAYER_COMMAND_REJECTED'));
    await expect(page.getByRole('button', { name: 'Output preparation failed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Output preparation failed', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Signal path' })).toContainText('HQPlayer rejected');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await expect(page.getByRole('button', { name: 'Output preparation failed', exact: true })).toHaveCount(0);
});

test('signal path is optional, reports source resolution, and responds to narrow and short windows', async ({ mount, page }) => {
    await mount('nativeAudio');
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.locator('[data-signal-path]')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show audio signal path' }).click();
    await page.locator('[data-signal-path] > button').click();
    const panel = page.getByRole('region', { name: 'Signal path' });
    await expect(panel).toContainText('FLAC');
    await expect(panel).toContainText('96 kHz');
    await expect(panel).toContainText('-6.02 dB');
    await expect(panel).toHaveCSS('backdrop-filter', /blur\(/);
    await page.setViewportSize({ width: 1000, height: 660 });
    await expect(panel).toHaveAttribute('data-columns', 'true');
    await expect.poll(() => panel.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    await page.screenshot({ path: 'test-results/native-signal-path-wide.png' });
    await page.setViewportSize({ width: 480, height: 800 });
    await expect(panel).toHaveAttribute('data-columns', 'false');
    await expect.poll(() => panel.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    await page.screenshot({ path: 'test-results/native-signal-path-narrow.png' });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
});

for (const installed of [false, true]) {
    test('HQPlayer dependency independent of disabled native component: installed=' + installed, async ({ mount, page }) => {
        await page.addInitScript(value => {
            localStorage.setItem('folia_native_audio_backend', 'browser');
            localStorage.setItem('hqplayer_installed', String(value));
        }, installed);
        await mount('nativeAudio', { hqplayer: true });
        await page.getByRole('button', { name: 'Disable component', exact: true }).click();
        const hq = page.locator('#settings-hqPlayerOutput');
        await hq.getByRole('button', { name: 'Use HQPlayer output', exact: true }).click();
        if (installed) {
            await expect(hq.getByRole('button', { name: 'Return to browser playback', exact: true })).toBeVisible();
            await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('hqplayer');
            await hq.getByRole('switch', { name: 'Show audio signal path' }).click();
            await expect(hq.getByRole('switch', { name: 'Show audio signal path' })).toBeChecked();
            await page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true }).click();
            await expect(page.getByRole('option').filter({ hasText: 'HQPlayer' })).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'WASAPI / ASIO exclusive playback', exact: true })).toContainText('Select a WASAPI / ASIO device');
        } else {
            await expect(hq.getByRole('status')).toContainText('Install HQPlayer');
            await expect(hq.getByRole('spinbutton', { name: 'HQPlayer gain headroom (dB)', exact: true })).toBeDisabled();
            expect(await page.evaluate(() => localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
        }
    });
}

test('HQPlayer offers a manual path when automatic discovery fails and preserves cancellation', async ({ mount, page }) => {
    await page.addInitScript(() => { localStorage.setItem('folia_native_audio_backend', 'browser'); localStorage.setItem('hqplayer_mock_cancel','true'); });
    await mount('nativeAudio', { hqplayer: true });
    const hq=page.locator('#settings-hqPlayerOutput');
    await expect(hq.getByRole('status')).toContainText('Install HQPlayer');
    await hq.getByRole('button', { name: 'Choose program path…', exact:true }).click();
    await expect(hq.getByTestId('hqplayer-program-path')).toContainText('Not found');
    await page.evaluate(()=>localStorage.setItem('hqplayer_mock_cancel','false'));
    await hq.getByRole('button', { name: 'Choose program path…', exact:true }).click();
    await expect(hq.getByTestId('hqplayer-program-path')).toContainText('HQPlayer5Desktop.exe');
    await expect(hq.getByRole('spinbutton', { name: 'HQPlayer gain headroom (dB)', exact: true })).toBeEnabled();
    expect(await page.evaluate(()=>localStorage.getItem('folia_native_audio_backend'))).toBe('browser');
    await hq.getByRole('button', { name: 'Restore automatic detection', exact:true }).click();
    await expect(hq.getByTestId('hqplayer-program-path')).toContainText('Not found');
    await expect(hq.getByRole('spinbutton', { name: 'HQPlayer gain headroom (dB)', exact: true })).toBeDisabled();
});
