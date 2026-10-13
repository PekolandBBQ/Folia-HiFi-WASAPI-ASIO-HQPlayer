import { describe, expect, it } from 'vitest';
import { mergeCollectionPage, syncRemainingCollectionPages } from '../../../src/components/folia-grid/onlineCollectionSync';
import { publicPlaylistSourceUrl } from '../../../src/components/folia-grid/CollectionMetadataNotice';
import { formatGridTrackDuration } from '../../../src/components/folia-grid/polaroidCardParts';

// publicPlaylistOccurrences.test.ts — Playlist rows keep their source order, including repeated recordings.
describe('public playlist occurrence contract', () => {
    it('shows unknown public duration without asserting a zero-length recording', () => {
        expect(formatGridTrackDuration({ durationMs: 0, sourceRef: { kind: 'online', providerId: 'spotify',
            mediaId: 'x', providerData: { durationKnown: false } } })).toBe('--:--');
        expect(formatGridTrackDuration({ durationMs: 200100, sourceRef: { kind: 'online', providerId: 'spotify',
            mediaId: 'x', providerData: { durationKnown: true } } })).toBe('3:20');
        expect(formatGridTrackDuration({ durationMs: 0 })).toBe('0:00');
    });

    it('keeps repeated tracks within and across pages', async () => {
        const rows = ['a', 'a', 'b', 'a', 'c', 'c'].map(id => ({ id }));
        const first = mergeCollectionPage([], 0, { items: rows.slice(0, 2), nextOffset: 2, hasMore: true,
            preserveDuplicates: true }, item => item.id);
        const result = await syncRemainingCollectionPages({ initialItems: first.items, startOffset: 2,
            getKey: item => item.id, isCancelled: () => false, onPage: () => {}, wait: async () => {},
            fetchPage: async offset => ({ items: rows.slice(offset, offset + 2), nextOffset: offset + 2,
                hasMore: offset + 2 < rows.length, preserveDuplicates: true }),
        });
        expect(result).toEqual({ status: 'complete', offset: 6, items: rows });
    });

    it('retains existing deduplication for providers without ordered occurrence metadata', () => {
        const result = mergeCollectionPage([{ id: 'a' }], 1,
            { items: [{ id: 'a' }, { id: 'b' }], nextOffset: 3, hasMore: false }, item => item.id);
        expect(result.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    it('only links an exact official playlist source URL', () => {
        const valid = 'https://open.spotify.com/playlist/5ZAFjUGN7Wsip8May2qDuq';
        expect(publicPlaylistSourceUrl(valid)).toBe(valid);
        for (const value of [undefined, 'javascript:alert(1)', valid + '?token=secret', valid + '#x',
            valid.replace('https:', 'http:'), valid.replace('open.spotify.com', 'open.spotify.com.evil.test'),
            valid.replace('open.spotify.com', 'user@open.spotify.com'), valid.replace('/playlist/', '/embed/playlist/')]) {
            expect(publicPlaylistSourceUrl(value)).toBeUndefined();
        }
    });
});
