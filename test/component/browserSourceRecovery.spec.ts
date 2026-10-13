import { test, expect } from './fixtures';

// test/component/browserSourceRecovery.spec.ts — real Chromium recovery after a same-address media rejection.
function pcmWave() {
    const rate = 48000, size = rate * 2 * 2 * 4;
    const buffer = Buffer.alloc(44 + size);
    buffer.write('RIFF'); buffer.writeUInt32LE(size + 36, 4); buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28);
    buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
    return buffer;
}

for (const intent of ['resume', 'pause', 'change-source'] as const) {
    test(`same-URL browser recovery respects ${intent}`, async ({ page }) => {
        let valid = false, release: (() => void) | undefined;
        let responses = 0;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const source = 'http://127.0.0.1:4173/__recovery_audio__.wav';
        const replacement = 'http://127.0.0.1:4173/__replacement_audio__.wav';
        await page.route('**/__recovery_audio__.wav', async route => {
            responses++;
            if (!valid) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'temporarily unavailable' });
            await waiting;
            return route.fulfill({ status: 200, contentType: 'audio/wav', body: pcmWave() });
        });
        await page.route('**/__replacement_audio__.wav', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: pcmWave() }));
        await page.goto('/dev-probe.html');
        await page.evaluate(async source => {
            const audio = document.createElement('audio');
            const probe = { audio, wantsPlayback: true, callbacks: 0, recovered: false, rejection: 0, replayError: '' };
            (window as any).__sourceRecovery = probe;
            audio.muted = true;
            audio.preload = 'auto'; audio.src = source; document.body.append(audio);
            await new Promise<void>(resolve => audio.addEventListener('error', () => {
                probe.rejection = audio.error?.code || 0; resolve();
            }, { once: true }));
        }, source);
        expect(await page.evaluate(() => (window as any).__sourceRecovery.rejection)).toBe(4);
        valid = true;
        await page.evaluate(async source => {
            const modulePath = '/src/services/playbackRecovery/reloadRecoveredSource.ts';
            const { reloadRecoveredSource } = await import(modulePath);
            const probe = (window as any).__sourceRecovery;
            probe.recovered = reloadRecoveredSource(probe.audio, source, () => {
                probe.callbacks++;
                if (!probe.wantsPlayback) return;
                probe.audio.currentTime = 1;
                void probe.audio.play().catch((error: Error) => { probe.replayError = error.name; });
            });
        }, source);
        expect(await page.evaluate(() => (window as any).__sourceRecovery.recovered)).toBe(true);
        await expect.poll(() => responses).toBe(2);
        if (intent === 'pause') await page.evaluate(() => { (window as any).__sourceRecovery.wantsPlayback = false; });
        if (intent === 'change-source') await page.evaluate(source => { (window as any).__sourceRecovery.audio.src = source; }, replacement);
        release!();
        await expect.poll(() => page.evaluate(() => (window as any).__sourceRecovery.audio.readyState)).toBeGreaterThanOrEqual(3);
        if (intent === 'resume') {
            await expect.poll(() => page.evaluate(() => (window as any).__sourceRecovery.audio.currentTime)).toBeGreaterThan(1.15);
            expect(await page.evaluate(() => (window as any).__sourceRecovery.audio.paused)).toBe(false);
            expect(await page.evaluate(() => (window as any).__sourceRecovery.callbacks)).toBe(1);
        } else {
            expect(await page.evaluate(() => (window as any).__sourceRecovery.audio.paused)).toBe(true);
            expect(await page.evaluate(() => (window as any).__sourceRecovery.callbacks)).toBe(intent === 'pause' ? 1 : 0);
        }
        expect(responses).toBe(2);
        expect(await page.evaluate(() => (window as any).__sourceRecovery.audio.error)).toBeNull();
        expect(await page.evaluate(() => (window as any).__sourceRecovery.replayError)).toBe('');
    });
}
