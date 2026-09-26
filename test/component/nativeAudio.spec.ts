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
        Object.assign(window, { __nativeRequests: requests,
            __nativeFailure: (errorCode: string) => listeners.forEach(listener => listener({ event: 'error', session: state.session, errorCode })),
            electron: {
            webUtils: { getPathForFile: () => 'C:\\fixture.flac' },
            nativeAudio: {
                supported: true,
                onEvent: (listener: (value: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
                request: async (request: Record<string, unknown>) => {
                    requests.push(request);
                    if (request.action === 'component-rollback') return { ok: true };
                    if (request.action === 'status') return { supported: true, available: true, installed: true, installable: true, version: '0.1.0' };
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
    await page.getByRole('button', { name: 'Windows local audio output' }).click();
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
    await page.getByRole('button', { name: 'Windows local audio output' }).click();
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
