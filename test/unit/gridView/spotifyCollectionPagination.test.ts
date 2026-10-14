import { describe, expect, it, vi } from 'vitest';
import { mergeCollectionPage, syncRemainingCollectionPages } from '@/library/core/services/onlineCollectionSync';
import { createCollectionTrackSnapshot, readCollectionTrackSnapshot } from '@/library/suites/grid/shared/onlineCollectionCache';
import { MAX_PROVIDER_PAGES } from '@/services/onlineMusic/providerPagination';
import { normalizeSpotifyPage, normalizeSpotifySong } from '@/services/onlineMusic/spotifyNormalize';

// test/unit/gridView/spotifyCollectionPagination.test.ts

const song = (index: number) => ({ id: String(index).padStart(22, '0'), name: `Track ${index}`, type: 'track', artists: [], album: {} });
const serving = (rows: unknown[]) => vi.fn(async (offset: number) => normalizeSpotifyPage({
    items: rows.slice(offset, offset + 50), total: rows.length, next: offset + 50 < rows.length,
}, offset, normalizeSpotifySong, true));
const options = {
    initialItems: [], startOffset: 0, getKey: (item: { id: string | number }) => String(item.id),
    isCancelled: () => false, onPage: vi.fn(), wait: async () => {},
};

describe('Spotify normalized collection pagination', () => {
    it('stops after an upstream three-item terminal page without inventing another request', async () => {
        const fetchPage = serving([1, 2, 3].map(index => ({ item: song(index) })));
        const result = await syncRemainingCollectionPages({ ...options, total: 500, fetchPage });
        expect(result).toMatchObject({ status: 'complete', offset: 3 });
        expect(result.items).toHaveLength(3);
        expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0]);
    });

    it('preserves the raw first/manual cursor and continuation independently of visible count', () => {
        const first = normalizeSpotifyPage({ items: [{ item: song(1) }, { item: null }], next: true, total: 4 }, 0, normalizeSpotifySong, true);
        const initial = mergeCollectionPage([], 0, first, item => String(item.id));
        expect(initial).toMatchObject({ offset: 2, hasMore: true, items: [{ id: song(1).id }] });
        const middle = normalizeSpotifyPage({ items: [{ item: null }], next: true, total: 4 }, 2, normalizeSpotifySong, true);
        const continued = mergeCollectionPage(initial.items, initial.offset, middle, item => String(item.id));
        expect(continued).toEqual({ ...initial, offset: 3 });
        const last = normalizeSpotifyPage({ items: [{ track: song(1) }], next: null, total: 4 }, 3, normalizeSpotifySong, true);
        expect(mergeCollectionPage(continued.items, continued.offset, last, item => String(item.id)))
            .toEqual({ items: initial.items, offset: 4, hasMore: false });
    });

    it('round trips filtered-empty partial snapshots with cursor and continuation', () => {
        const snapshot = createCollectionTrackSnapshot([], 50, true, 100, 200);
        expect(readCollectionTrackSnapshot(snapshot, 100)).toEqual(snapshot);
        const final = createCollectionTrackSnapshot([song(1)], 200, false, 100, 200);
        expect(readCollectionTrackSnapshot(final, 100)).toMatchObject({ nextOffset: 200, hasMore: false });
        expect(readCollectionTrackSnapshot({ tracks: [song(1)], snapshotTime: 100, schemaVersion: 5 }, 100)).toBeNull();
        expect(readCollectionTrackSnapshot(snapshot, 101)).toBeNull();
        expect(readCollectionTrackSnapshot({ ...snapshot, nextOffset: Number.NaN }, 100)).toBeNull();
    });
    it('walks past a filtered-only first page using its raw offset', async () => {
        const fetchPage = serving([...Array(50).fill({ item: null }), { item: song(1) }]);
        const result = await syncRemainingCollectionPages({ ...options, total: 51, fetchPage });
        expect(result).toMatchObject({ status: 'complete', offset: 51, items: [{ id: song(1).id }] });
        expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 50]);
    });

    it('walks past a filtered-only middle page without dropping valid later songs', async () => {
        const rows = [...Array.from({ length: 50 }, (_, index) => ({ item: song(index) })),
            ...Array(50).fill({ item: null }), { track: song(51) }];
        const fetchPage = serving(rows);
        const first = await fetchPage(0);
        const result = await syncRemainingCollectionPages({ ...options, initialItems: first.items, startOffset: first.nextOffset, total: rows.length, fetchPage });
        expect(result).toMatchObject({ status: 'complete', offset: 101 });
        expect(result.items).toHaveLength(51);
        expect(result.items.at(-1)?.id).toBe(song(51).id);
        expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 50, 100]);
    });

    it('fails a continuation with a stalled cursor instead of reporting complete', async () => {
        const stalled = normalizeSpotifyPage({ items: [], next: true, total: 50 }, 0, normalizeSpotifySong, true);
        expect(stalled.hasMore).toBe(true);
        const result = await syncRemainingCollectionPages({ ...options, total: 50,
            fetchPage: async () => stalled });
        expect(result).toMatchObject({ status: 'failed', offset: 0 });
    });

    it('fails a non-finite continuation cursor without emitting a page', async () => {
        const onPage = vi.fn();
        const result = await syncRemainingCollectionPages({ ...options, onPage,
            fetchPage: async () => ({ items: [], nextOffset: Number.NaN, hasMore: true }) });
        expect(result).toMatchObject({ status: 'failed', offset: 0 });
        expect(onPage).not.toHaveBeenCalled();
    });

    it('follows explicit continuation even when an earlier total was smaller', async () => {
        const fetchPage = serving(Array.from({ length: 51 }, (_, index) => ({ item: song(index) })));
        const result = await syncRemainingCollectionPages({ ...options, total: 0, fetchPage });
        expect(result).toMatchObject({ status: 'complete', offset: 51 });
        expect(result.items).toHaveLength(51);
    });

    it('completes a terminal filtered-only page at its raw cursor', async () => {
        const onPage = vi.fn();
        const result = await syncRemainingCollectionPages({ ...options, onPage, fetchPage: serving(Array(50).fill({ item: null })) });
        expect(result).toEqual({ status: 'complete', items: [], offset: 50 });
        expect(onPage).toHaveBeenCalledWith([], 50, false);
    });

    it('reports the bounded page limit as resumable failure with known or unknown totals', async () => {
        for (const total of [undefined, 100_000]) {
            const fetchPage = vi.fn(async (offset: number) => ({ items: [], nextOffset: offset + 1, hasMore: true, total }));
            const result = await syncRemainingCollectionPages({ ...options, total, fetchPage });
            expect(result).toMatchObject({ status: 'failed', offset: MAX_PROVIDER_PAGES, error: { message: expect.stringContaining('page-limit') } });
            expect(fetchPage).toHaveBeenCalledTimes(MAX_PROVIDER_PAGES);
        }
    });
});
