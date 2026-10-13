import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { assertHQPlayerWindowVisibility } = createRequire(import.meta.url)('../../manual/hqplayerWindowState.cjs');
const observation = (windows: unknown[], pids = [12]) => ({ pids, windows });
const visible = { visible: true, minimized: false, cloaked: 0, dwmResult: 0 };

describe('HQPlayer real screen visibility acceptance', () => {
    it('accepts a DWM cloaked Win32 visible main window as silent and requires uncloak for foreground', () => {
        const cloaked = observation([{ ...visible, cloaked: 1 }]);
        expect(assertHQPlayerWindowVisibility(cloaked, true)).toBe(false);
        expect(() => assertHQPlayerWindowVisibility(cloaked, false)).toThrow('visibility mismatch');
        expect(assertHQPlayerWindowVisibility(observation([visible]), false)).toBe(true);
        expect(() => assertHQPlayerWindowVisibility(observation([visible]), true)).toThrow('visibility mismatch');
    });
    it('fails an unknown DWM observation rather than silently treating a visible window as hidden', () => {
        expect(() => assertHQPlayerWindowVisibility(observation([{ ...visible, cloaked: null, dwmResult: -1 }]), true)).toThrow('could not be verified');
        expect(() => assertHQPlayerWindowVisibility(observation([{ ...visible, cloaked: 1, dwmResult: -1 }]), true)).toThrow('could not be verified');
        expect(assertHQPlayerWindowVisibility(observation([{ ...visible, visible: false, cloaked: null, dwmResult: -1 }]), true)).toBe(false);
    });
    it('rejects extra instances, no windows or a visible new dialog during silent playback', () => {
        expect(() => assertHQPlayerWindowVisibility(observation([], [12]), true)).toThrow('unavailable');
        expect(() => assertHQPlayerWindowVisibility(observation([visible], [12, 13]), false)).toThrow('unavailable');
        expect(() => assertHQPlayerWindowVisibility(observation([{ ...visible, cloaked: 1 }, visible]), true)).toThrow('visibility mismatch');
    });
});
