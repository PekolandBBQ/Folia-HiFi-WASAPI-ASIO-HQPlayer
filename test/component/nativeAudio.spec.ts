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
                    if (request.action === 'component-rollback') return { ok: true };
                    if (request.action === 'status') return { supported: true, ...component, version: component.installed ? '0.1.0' : undefined };
                    if (request.action === 'component-uninstall') { component.available = false; component.installed = false; return { ok: true }; }
                    if (request.action === 'component-install') {
                        if (component.failInstall) throw Object.assign(new Error('private diagnostic'), { code: 'COMPONENT_UPDATE_FAILED' });
                        component.available = true; component.installed = true; return { ok: true };
                    }
                    if (request.action === 'devices') return [
                        { backend: 'wasapi-exclusive', id: 'wasapi-device', name: 'Test DAC' },
                        { backend: 'asio', id: 'asio-device', name: 'Test ASIO Driver' },
                    ];
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
        await mount('nativeAudio');
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
    await expect.poll(() => page.evaluate(() => {
        const requests = (window as unknown as { __nativeRequests: Array<Record<string, unknown>> }).__nativeRequests;
        return requests.slice().reverse().find(request => request.action === 'begin')?.processingMode;
    })).toBe('integer-direct');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
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
    await expect(page.getByTestId('status')).toHaveText('ready');
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
    await expect(page.getByTestId('status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('playing');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByTestId('status')).toHaveText('paused');
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
