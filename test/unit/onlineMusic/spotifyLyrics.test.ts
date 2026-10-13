import { describe, expect, it } from 'vitest';
import { normalizeSpotifyLyrics } from '../../../src/services/onlineMusic/spotifyLyrics';

// Native Spotify timing and identity must survive the provider boundary.
describe('Spotify native lyrics', () => {
    const payload = { trackId: 'track', source: 'spotify-native', syncType: 'LINE_SYNCED', lines: [
        { startTimeMs: '1234', words: 'First' }, { startTimeMs: '62500', words: 'Second' },
    ] };
    it('preserves millisecond timing without inventing word timing', () => {
        const result = normalizeSpotifyLyrics(payload, 'track');
        expect(result.mainText).toContain('[00:01.234]First');
        expect(result.lyrics?.lines[0].startTime).toBeCloseTo(1.234);
        expect(result.lyrics?.isWordByWord).not.toBe(true);
        expect(result.isPureMusic).toBe(false);
    });
    it('rejects another track and never interprets missing lyrics as instrumental', () => {
        expect(normalizeSpotifyLyrics(payload, 'different')).toMatchObject({ lyrics: null, isPureMusic: false });
        expect(normalizeSpotifyLyrics({ ...payload, lines: [] }, 'track')).toMatchObject({ lyrics: null, isPureMusic: false });
    });
    it('retains unsynced text without fabricated timestamps', () => {
        expect(normalizeSpotifyLyrics({ ...payload, syncType: 'UNSYNCED' }, 'track'))
            .toMatchObject({ lyrics: null, mainText: 'First\nSecond', isPureMusic: false });
    });
});
