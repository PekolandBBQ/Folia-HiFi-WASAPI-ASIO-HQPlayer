import { describe, expect, it, vi } from 'vitest';
import { reloadRecoveredSource } from '../../../src/services/playbackRecovery/reloadRecoveredSource';

// test/unit/playbackRecovery/reloadRecoveredSource.test.ts — rejected and stale media source ownership.
function browser(currentSrc = '') {
    const target = new EventTarget();
    const state = { source: 'https://audio.example/current', error: { code: 4 } as unknown, currentSrc };
    const load = vi.fn();
    return { state, load, element: Object.defineProperties(Object.assign(target, {
        getAttribute: () => state.source,
        load,
    }), {
        currentSrc: { get: () => state.currentSrc },
        error: { get: () => state.error },
    }) as unknown as HTMLAudioElement };
}

describe('same-address media recovery ownership', () => {
    it('retries source-not-supported with an empty currentSrc without claiming it is already ready', () => {
        const { element, state, load } = browser();
        const ready = vi.fn();
        expect(reloadRecoveredSource(element, state.source, ready)).toBe(true);
        expect(load).toHaveBeenCalledOnce();
        element.dispatchEvent(new Event('canplay'));
        expect(ready).not.toHaveBeenCalled();
    });

    it('leaves a healthy or changed assigned source untouched', () => {
        const { element, state, load } = browser('https://audio.example/current');
        expect(reloadRecoveredSource(element, 'https://audio.example/old')).toBe(false);
        state.error = null;
        expect(reloadRecoveredSource(element, state.source)).toBe(false);
        expect(load).not.toHaveBeenCalled();
    });

    it('removes the old readiness callback after another rejection', () => {
        const { element, state } = browser('https://audio.example/current');
        const ready = vi.fn();
        expect(reloadRecoveredSource(element, state.source, ready)).toBe(true);
        element.dispatchEvent(new Event('error'));
        state.error = null;
        element.dispatchEvent(new Event('canplay'));
        expect(ready).not.toHaveBeenCalled();
    });
});
