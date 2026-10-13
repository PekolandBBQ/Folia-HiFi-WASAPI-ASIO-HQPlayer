import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/privateDiagnosticsPreload.test.ts — execute the actual preload with a mock Electron host.
const source = readFileSync(new URL('../../../electron/preload.cjs', import.meta.url), 'utf8');
function preload(argv: string[], isMainFrame: unknown = true) {
    let bridge: any;
    const invoke = vi.fn(async () => ({ ok: true }));
    vm.runInNewContext(source, { require: () => ({
        contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } },
        ipcRenderer: { invoke }, webUtils: {},
    }), process: { argv, isMainFrame, platform: 'win32', arch: 'x64', env: {} } });
    return { bridge, invoke };
}
describe('private diagnostics preload gate', () => {
    it.each([[], ['--folia-spotify-preview'], ['--folia-private-diagnostics=true'], ['--folia-private-diagnostics=1'], ['private-diagnostics']].map(argv => ({ argv })))('does not expose private diagnostics for other arguments $argv', ({ argv }) => {
        const { bridge } = preload(argv);
        expect(bridge.privatePreview).toBeUndefined(); expect(bridge.privateDiagnostics).toBeUndefined();
    });
    it.each([false, undefined, 'true'])('does not expose diagnostics to a non-main frame (%s)', value => {
        const { bridge } = preload(['--folia-private-diagnostics'], value === undefined ? null : value);
        expect(bridge.privateDiagnostics).toBeUndefined();
    });
    it('exposes only the five bounded operations and never accepts a path or generic channel', async () => {
        const { bridge, invoke } = preload(['--folia-private-diagnostics']);
        expect(bridge.privatePreview).toBe(true);
        expect(Object.keys(bridge.privateDiagnostics).sort()).toEqual(['armPauseResponseInspection', 'export', 'openFolder', 'record', 'status']);
        await bridge.privateDiagnostics.status('/secret'); await bridge.privateDiagnostics.openFolder('/secret');
        await bridge.privateDiagnostics.export('/secret');
        await bridge.privateDiagnostics.armPauseResponseInspection('/secret', { body: 'raw', channel: 'evil' });
        bridge.privateDiagnostics.record({ action: 'evil', channel: 'evil', event: 'output.handoff', fields: { phase: 'captured' } });
        expect(invoke.mock.calls).toEqual([
            ['private-preview-diagnostics:request', { action: 'status' }],
            ['private-preview-diagnostics:request', { action: 'openFolder' }],
            ['private-preview-diagnostics:request', { action: 'export' }],
            ['private-preview-diagnostics:request', { action: 'armPauseResponseInspection' }],
            ['private-preview-diagnostics:request', { action: 'record', event: 'output.handoff', fields: { phase: 'captured' } }],
        ]);
    });
    it('keeps the flag out of ordinary main windows unless the exact private environment value is set', () => {
        const main = readFileSync(new URL('../../../electron/main.cjs', import.meta.url), 'utf8');
        const expression = main.match(/additionalArguments: (\[[\s\S]*?\n        \]),/)?.[1];
        expect(expression).toBeTruthy();
        for (const flag of [undefined, '', 'true', 'false', '0', '01', '1']) {
            const args = vm.runInNewContext(expression!, { process: { env: { FOLIA_PRIVATE_DIAGNOSTICS: flag, FOLIA_SPOTIFY_PREVIEW: '1' } } });
            expect(args.includes('--folia-private-diagnostics')).toBe(flag === '1');
        }
        expect(main).not.toContain('installPrivatePreviewDiagnostics(');
    });
});
