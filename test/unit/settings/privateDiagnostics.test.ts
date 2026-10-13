// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeveloperSettingsSubview from '../../../src/components/modal/settings/DeveloperSettingsSubview';
import type { PauseResponseInspectionResult, PrivateDiagnosticsApi, PrivateDiagnosticsActionResult, PrivateDiagnosticsStatus } from '../../../src/types/privateDiagnostics';
import en from '../../../src/i18n/locales/en';
import zh from '../../../src/i18n/locales/zh-CN';
import indonesian from '../../../src/i18n/locales/in';

// test/unit/settings/privateDiagnostics.test.ts — real settings controls, mocked Electron IPC only.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values: Record<string, unknown> = {}) => {
    const text = key.split('.').reduce((value: any, segment) => value?.[segment], en) || key;
    return text.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(values[name] ?? ''));
} }) }));
let root: Root | undefined, host: HTMLDivElement;
const state: PrivateDiagnosticsStatus = { enabled: true, available: true, recording: true, busy: false,
    pauseResponseInspection: 'idle',
    runId: 'private-run', buildRef: 'preview', recordCount: 31, fileCount: 2, totalBytes: 4096,
    maxFiles: 5, maxFileBytes: 1048576, droppedRecords: 2, writeErrors: 1, rejectedRecords: 3, exportedArchives: 4, exportErrors: 1 };
function bridge(patch: Partial<PrivateDiagnosticsApi> = {}) {
    const api = { status: vi.fn(async () => ({ ...state })), openFolder: vi.fn(async () => ({ ok: true })),
        export: vi.fn(async (): Promise<PrivateDiagnosticsActionResult> => ({ ok: false, canceled: true })),
        armPauseResponseInspection: vi.fn(async (): Promise<PauseResponseInspectionResult> => ({ ok: true, pauseResponseInspection: 'armed' })),
        record: vi.fn(), ...patch };
    const rawWrite = vi.fn();
    Object.assign(window, { electron: { privatePreview: true, privateDiagnostics: api,
        debugSetState: rawWrite, debugWriteRuntimeLines: rawWrite } });
    return { api, rawWrite };
}
async function mount(isDaylight = false, strict = false) {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const component = React.createElement(DeveloperSettingsSubview, { isDaylight, settingsCardClass: 'settings-card', toggleOffBackgroundClass: 'toggle-off' });
    await act(async () => root!.render(strict ? React.createElement(React.StrictMode, null, component) : component));
}
function button(text: string) { return Array.from(host.querySelectorAll('button')).find(value => value.textContent === text)!; }
const exportButton = () => button(en.options.privateDiagnosticsExport);
const openButton = () => button(en.options.privateDiagnosticsOpen);
const armButton = () => button(en.options.privateDiagnosticsInspectionArm);
const result = () => host.querySelector('[aria-label="Diagnostic action result"]')?.textContent;
const inspectionResult = () => host.querySelector('[aria-label="Pause response inspection status"]')?.textContent;
async function reopen(isDaylight = false) {
    act(() => root!.unmount()); root = undefined; host.remove(); await mount(isDaylight);
}
beforeEach(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(() => {
    if (root) act(() => root!.unmount()); root = undefined; host?.remove();
    delete window.electron; vi.useRealTimers(); vi.restoreAllMocks();
});

describe('private diagnostic settings', () => {
    it.each(['absent', 'bridge-only', 'truthy-flag', 'flag-only'])('keeps ordinary controls unless the exact private capability exists (%s)', async kind => {
        const { api } = bridge();
        if (kind === 'absent') delete window.electron;
        if (kind === 'bridge-only') delete window.electron!.privatePreview;
        if (kind === 'truthy-flag') (window.electron as any).privatePreview = 'true';
        if (kind === 'flag-only') delete window.electron!.privateDiagnostics;
        await mount();
        expect(host.querySelector('[data-testid="private-diagnostics"]')).toBeNull();
        expect(armButton()).toBeUndefined(); expect(api.armPauseResponseInspection).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Session log'); expect(api.status).not.toHaveBeenCalled();
    });
    it.each([false, true])('shows continuous status, bounded retention and counters in daylight=%s', async isDaylight => {
        const { rawWrite } = bridge(); await mount(isDaylight, true);
        expect(host.textContent).toContain('Recording continuously');
        expect(host.textContent).toContain('Recorded events: 31 · Write failures: 1 · Dropped events: 2');
        expect(host.textContent).toContain('Saved exports: 4 · Export failures: 1 · Rejected events: 3');
        expect(host.textContent).toContain('5 × 1 MiB (5 MiB total)');
        expect(host.textContent).toContain('Export excludes raw runtime and crash logs, media, and account secrets.');
        expect(host.textContent).toContain('Nothing is uploaded automatically.');
        expect(host.textContent).not.toContain('Session log'); expect(rawWrite).not.toHaveBeenCalled();
    });
    it('reports canceled export honestly, allows retry, then opens the folder', async () => {
        const { api, rawWrite } = bridge(); await mount();
        await act(async () => exportButton().click());
        expect(result()).toBe('Export canceled. No file saved.');
        expect(host.textContent).not.toContain('Diagnostic ZIP saved.');
        vi.mocked(api.export).mockResolvedValueOnce({ ok: true });
        await act(async () => exportButton().click()); expect(result()).toBe('Diagnostic ZIP saved.');
        await act(async () => openButton().click()); expect(result()).toBe('Diagnostic folder opened.');
        expect(api.export).toHaveBeenCalledTimes(2); expect(api.openFolder).toHaveBeenCalledOnce(); expect(rawWrite).not.toHaveBeenCalled();
    });
    it('fences duplicate clicks and ignores old export success after close and reopen', async () => {
        let resolve!: (result: PrivateDiagnosticsActionResult) => void;
        const { api } = bridge({ export: vi.fn(() => new Promise<PrivateDiagnosticsActionResult>(value => { resolve = value; })) });
        await mount();
        await act(async () => { exportButton().click(); exportButton().click(); openButton().click(); });
        expect(api.export).toHaveBeenCalledOnce(); expect(api.openFolder).not.toHaveBeenCalled();
        expect(exportButton().disabled).toBe(true); expect(openButton().disabled).toBe(true);
        expect(result()).toContain('in progress');
        act(() => root!.unmount()); root = undefined; host.remove(); await mount();
        await act(async () => resolve({ ok: true }));
        expect(result()).toBe(''); expect(exportButton().disabled).toBe(false);
    });
    it('uses fixed error text and recovers from failed status on the next interval', async () => {
        vi.useFakeTimers();
        const { api } = bridge({ status: vi.fn().mockRejectedValueOnce(new Error('PRIVATE_STATUS_SENTINEL')).mockResolvedValue({ ...state }),
            export: vi.fn().mockRejectedValueOnce(new Error('PRIVATE_PATH_SECRET')) });
        await mount(); expect(host.textContent).toContain('Unable to read diagnostic status. Retrying automatically.');
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(host.textContent).toContain('Recording continuously');
        await act(async () => exportButton().click());
        expect(result()).toBe('The diagnostic action could not complete. Try again.');
        expect(host.textContent).not.toContain('PRIVATE_'); expect(exportButton().disabled).toBe(false);
        expect(api.status).toHaveBeenCalledTimes(3);
    });
    it('represents disabled recording and host-wide busy state without claiming success', async () => {
        const { api } = bridge({ status: vi.fn(async () => ({ ...state, busy: true, recording: false })) });
        await mount();
        expect(host.textContent).toContain('Diagnostic recording is unavailable.');
        expect(exportButton().disabled).toBe(true); expect(openButton().disabled).toBe(true);
        await act(async () => exportButton().click()); expect(api.export).not.toHaveBeenCalled();
        expect(result()).toContain('in progress');
    });
    it.each([{ ok: false, busy: true }, { ok: false, errorCode: 'PRIVATE_SECRET' }])('handles refused action results without displaying raw payloads: %j', async response => {
        bridge({ export: vi.fn(async () => response) }); await mount();
        await act(async () => exportButton().click());
        expect(result()).toBe(response.busy ? 'A diagnostic action is in progress…' : 'The diagnostic action could not complete. Try again.');
        expect(host.textContent).not.toContain('PRIVATE_SECRET'); expect(exportButton().disabled).toBe(false);
    });
    it('keeps private diagnostics translations complete in all supported dictionaries', () => {
        const keys = Object.keys(en.options).filter(key => key.startsWith('privateDiagnostics'));
        expect(keys.length).toBeGreaterThan(15);
        for (const locale of [zh, indonesian]) for (const key of keys) expect((locale.options as Record<string, unknown>)[key]).toEqual(expect.any(String));
    });
});

describe('one-time pause response inspection controls', () => {
    it.each([false, true])('offers a keyboard-focusable one-time action without arming on mount in daylight=%s', async isDaylight => {
        const { api, rawWrite } = bridge(); await mount(isDaylight, true);
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionIdle);
        expect(armButton().disabled).toBe(false); expect(armButton().type).toBe('button');
        armButton().focus(); expect(document.activeElement).toBe(armButton());
        expect(armButton().className).toContain('focus-visible:outline-2');
        expect(armButton().style.color).toBe('var(--text-primary)');
        const description = host.querySelector(`#${armButton().getAttribute('aria-describedby')}`)!;
        expect(description.textContent).toBe(en.options.privateDiagnosticsInspectionDescription);
        expect(description.textContent).toContain('128 bytes');
        expect(description.textContent).toContain('excluded from the diagnostic ZIP');
        expect(description.textContent).toContain('must stay local');
        expect(description.textContent).toContain('only a reviewed, clearly generic phrase may be shared');
        expect(api.armPauseResponseInspection).not.toHaveBeenCalled(); expect(rawWrite).not.toHaveBeenCalled();
    });
    it('keeps the arm button disabled until a successful status read, including older hosts', async () => {
        let resolve!: (status: PrivateDiagnosticsStatus) => void;
        const { api } = bridge({ status: vi.fn(() => new Promise<PrivateDiagnosticsStatus>(value => { resolve = value; })) });
        await mount(); expect(armButton().disabled).toBe(true);
        await act(async () => armButton().click()); expect(api.armPauseResponseInspection).not.toHaveBeenCalled();
        await act(async () => resolve({ ...state })); expect(armButton().disabled).toBe(false);
        delete (api as PrivateDiagnosticsApi).armPauseResponseInspection;
        await reopen();
        await act(async () => resolve({ ...state }));
        expect(armButton().disabled).toBe(true); expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionUnavailable);
    });
    it('fences same-frame clicks and other diagnostic actions while arm is pending', async () => {
        let resolve!: (result: PauseResponseInspectionResult) => void;
        const { api } = bridge({ armPauseResponseInspection: vi.fn(() => new Promise<PauseResponseInspectionResult>(value => { resolve = value; })) });
        await mount();
        await act(async () => { armButton().click(); armButton().click(); exportButton().click(); openButton().click(); });
        expect(api.armPauseResponseInspection).toHaveBeenCalledExactlyOnceWith();
        expect(api.export).not.toHaveBeenCalled(); expect(api.openFolder).not.toHaveBeenCalled();
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionPreparing);
        expect(armButton().disabled).toBe(true);
        await act(async () => resolve({ ok: true, pauseResponseInspection: 'armed' }));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionArmed);
        expect(armButton().disabled).toBe(true); expect(exportButton().disabled).toBe(false);
    });
    it('keeps the single attempt across close/reopen while IPC is pending, then reports a late failure safely', async () => {
        vi.useFakeTimers(); let reject!: (error: Error) => void;
        const { api } = bridge({ armPauseResponseInspection: vi.fn(() => new Promise<PauseResponseInspectionResult>((_resolve, value) => { reject = value; })) });
        await mount(); await act(async () => armButton().click()); await reopen();
        expect(armButton().disabled).toBe(true);
        await act(async () => armButton().click()); expect(api.armPauseResponseInspection).toHaveBeenCalledOnce();
        vi.mocked(api.status).mockResolvedValue({ ...state, pauseResponseInspection: 'failed' });
        await act(async () => reject(new Error('PRIVATE_RESPONSE_AND_PATH')));
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionFailed);
        expect(result()).toBe(''); expect(host.textContent).not.toContain('PRIVATE_RESPONSE_AND_PATH');
        expect(armButton().disabled).toBe(true); expect(exportButton().disabled).toBe(false);
        await reopen(); expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionFailed);
        expect(api.armPauseResponseInspection).toHaveBeenCalledOnce();
    });
    it('ignores a pre-arm status poll that resolves idle after arming, and observes later capture', async () => {
        vi.useFakeTimers(); let resolve!: (status: PrivateDiagnosticsStatus) => void;
        const { api } = bridge(); await mount();
        vi.mocked(api.status).mockImplementationOnce(() => new Promise<PrivateDiagnosticsStatus>(value => { resolve = value; }));
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        await act(async () => armButton().click());
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionArmed);
        await act(async () => resolve({ ...state }));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionArmed); expect(armButton().disabled).toBe(true);
        vi.mocked(api.status).mockResolvedValue({ ...state, pauseResponseInspection: 'captured' });
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionCaptured);
        await reopen(); expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionCaptured);
        expect(api.armPauseResponseInspection).toHaveBeenCalledOnce();
    });
    it('does not let a delayed arm response overwrite a capture already observed by polling', async () => {
        vi.useFakeTimers(); let resolve!: (result: PauseResponseInspectionResult) => void;
        const { api } = bridge({ armPauseResponseInspection: vi.fn(() => new Promise<PauseResponseInspectionResult>(value => { resolve = value; })) });
        await mount(); await act(async () => armButton().click());
        vi.mocked(api.status).mockResolvedValue({ ...state, pauseResponseInspection: 'captured' });
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionCaptured);
        await act(async () => resolve({ ok: true, pauseResponseInspection: 'armed' }));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionCaptured); expect(armButton().disabled).toBe(true);
    });
    it.each(['armed', 'captured', 'failed', 'unavailable'] as const)('shows process state %s after reopen without automatic rearming', async phase => {
        const { api } = bridge({ status: vi.fn(async () => ({ ...state, pauseResponseInspection: phase })) });
        await mount(); expect(armButton().disabled).toBe(true);
        const displayed = inspectionResult(); expect(displayed).not.toBe(en.options.privateDiagnosticsInspectionIdle);
        await reopen(true); expect(inspectionResult()).toBe(displayed); expect(armButton().disabled).toBe(true);
        expect(api.armPauseResponseInspection).not.toHaveBeenCalled();
    });
    it('disables arm on a failed status poll and recovers only from a current successful status', async () => {
        vi.useFakeTimers(); const { api } = bridge(); await mount();
        vi.mocked(api.status).mockRejectedValueOnce(new Error('PRIVATE_STATUS_RESPONSE'));
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionStatusFailed); expect(armButton().disabled).toBe(true);
        await act(async () => armButton().click()); expect(api.armPauseResponseInspection).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(3000));
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionIdle); expect(armButton().disabled).toBe(false);
        expect(host.textContent).not.toContain('PRIVATE_STATUS_RESPONSE');
    });
    it('does not expose malformed IPC fields or retry a failed arm within this process', async () => {
        const { api } = bridge({ armPauseResponseInspection: vi.fn(async () => ({ ok: false,
            pauseResponseInspection: 'failed', errorCode: 'PRIVATE_ERROR_RESPONSE', path: 'PRIVATE_LOCAL_PATH', body: 'PRIVATE_BODY' }) as any) });
        await mount(); await act(async () => armButton().click());
        expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionFailed); expect(host.textContent).not.toContain('PRIVATE_');
        await reopen(); await act(async () => armButton().click()); expect(api.armPauseResponseInspection).toHaveBeenCalledOnce();
        bridge(); await reopen(); expect(armButton().disabled).toBe(false);
    });
    it('maps missing and unexpected host states to fixed unavailable text', async () => {
        const { api } = bridge({ status: vi.fn(async () => ({ ...state, pauseResponseInspection: 'PRIVATE_BODY_PATH' }) as any) });
        await mount(); expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionUnavailable);
        expect(armButton().disabled).toBe(true); expect(host.textContent).not.toContain('PRIVATE_BODY_PATH');
        vi.mocked(api.status).mockResolvedValue({ ...state, pauseResponseInspection: undefined });
        await reopen(); expect(inspectionResult()).toBe(en.options.privateDiagnosticsInspectionUnavailable);
        expect(armButton().disabled).toBe(true); expect(api.armPauseResponseInspection).not.toHaveBeenCalled();
    });
});
