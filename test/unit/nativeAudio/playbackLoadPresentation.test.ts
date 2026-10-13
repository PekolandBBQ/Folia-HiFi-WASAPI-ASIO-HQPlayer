import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { describePlaybackLoad } from '../../../src/components/audio/playbackLoadPresentation';

// Buffer milliseconds, byte progress and unmeasured work must stay distinct in the loading disclosure.
const t = ((key: string, options?: { value?: string }) => options?.value ? `${key}:${options.value}` : key) as TFunction;
describe('loading presentation', () => {
    it('reports the measured amount and clamps a finished stage at 100%', () => {
        const result = describePlaybackLoad({ stage: 'download', loaded: 5242880, total: 4194304, elapsedMs: 2400 }, 1200, t);
        expect(result.percent).toBe(100);
        expect(result.completion).toBe('loadProgress.megabytes:5.0 / loadProgress.megabytes:4.0');
        expect(result.elapsed).toBe('loadProgress.seconds:2');
        expect(result.reason).toBe('loadProgress.reasons.download');
    });
    it('keeps a small prebuffer visible rather than rounding it to zero seconds', () => {
        const result = describePlaybackLoad({ stage: 'buffer', loaded: 200, total: 350, unit: 'milliseconds' }, 0, t);
        expect(result.percent).toBeCloseTo(57.142857);
        expect(result.completion).toBe('loadProgress.seconds:0.20 / loadProgress.seconds:0.35');
    });
    it.each([{ stage: 'decode' as const }, { stage: 'inspect' as const, loaded: NaN, total: 10 }, { stage: 'load' as const, loaded: -1, total: 10 }])('does not invent a percentage for $stage', progress => {
        const result = describePlaybackLoad(progress, -1000, t);
        expect(result.percent).toBeUndefined();
        expect(result.completion).toBe('loadProgress.unmeasured');
        expect(result.elapsed).toBe('loadProgress.seconds:0');
    });
});
