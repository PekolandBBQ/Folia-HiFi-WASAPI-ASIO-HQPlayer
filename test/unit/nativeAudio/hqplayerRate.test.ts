import { expect, it } from 'vitest';
import { formatHQPlayerRate } from '../../../src/utils/hqplayerRate';

// HQPlayer also exposes non-power-of-two SDM targets (48k x250/x500/x1000/x2000).
it.each([[49152000, '48k x1024'], [45158400, '44.1k x1024'], [32768000, '32k x1024'],
    [48000000, '48k x1000'], [12000000, '48k x250'], [22579200, '44.1k x512']])('formats SDM %i as %s', (rate, label) => {
    expect(formatHQPlayerRate(Number(rate), true)).toBe(label);
});
it('keeps PCM rates separate from SDM notation', () => expect(formatHQPlayerRate(192000, false)).toBe('192 kHz'));
