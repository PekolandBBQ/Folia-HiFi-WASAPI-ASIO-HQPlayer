import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
const { hqplayerWindow } = createRequire(import.meta.url)('../../../electron/nativeAudio/hqplayerWindow.cjs');

// Visibility only touches verified Desktop windows, never playback, process startup or termination.
it('reads without mutation and restricts visibility changes to HQPlayer Desktop', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"running":true,"visible":false,"controllable":true}' });
    expect(await hqplayerWindow(undefined, { exec })).toMatchObject({ running: true, visible: false });
    expect(exec.mock.calls[0][1].at(-1)).not.toContain('ShowWindowAsync($h,');
    await hqplayerWindow(true, { exec });
    const show = exec.mock.calls[1][1].at(-1);
    expect(show).toContain("'^HQPlayer[0-9]*Desktop$'");
    expect(show).toContain('ShowWindowAsync($h,9)');
    expect(show).toContain('SetForegroundWindow($h)');
    expect(show).not.toMatch(/Start-Process|Stop-Process|Kill|request\('Play'/);
    await hqplayerWindow(false, { exec });
    expect(exec.mock.calls[2][1].at(-1)).toContain('ShowWindowAsync($h,0)');
    expect(exec.mock.calls[2][2]).toMatchObject({ windowsHide: true, timeout: 8000 });
});
it('rejects arbitrary inputs before invoking PowerShell', async () => {
    const exec = vi.fn();
    await expect(hqplayerWindow('invalid', { exec })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(exec).not.toHaveBeenCalled();
});
