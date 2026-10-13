import { describe, expect, it, vi } from 'vitest';
import { assertProviderPageProgress, collectProviderPages, MAX_PROVIDER_PAGES } from '@/services/onlineMusic/providerPagination';

// test/unit/onlineMusic/providerPagination.test.ts

describe('provider collection pagination', () => {
    it('continues across filtered-empty pages and deduplicates using provider-aware identity', async () => {
        const first = { providerId: 'spotify', id: 'a' }, second = { providerId: 'other', id: 'a' };
        const fetchPage = vi.fn().mockResolvedValueOnce({ items: [first], nextOffset: 50, hasMore: true })
            .mockResolvedValueOnce({ items: [], nextOffset: 100, hasMore: true })
            .mockResolvedValueOnce({ items: [first, second], nextOffset: 102, hasMore: false });
        await expect(collectProviderPages<{ providerId: string; id: string }>({ fetchPage, getKey: row => `${row.providerId}:${row.id}` })).resolves.toEqual([first, second]);
        expect(fetchPage.mock.calls).toEqual([[0], [50], [100]]);
    });

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects stalled or invalid continuation %s', nextOffset => {
        expect(() => assertProviderPageProgress({ items: [], hasMore: true, nextOffset }, 0)).toThrow('invalid-cursor');
    });

    it('rejects a backwards terminal cursor but allows a truly empty terminal page', () => {
        expect(() => assertProviderPageProgress({ items: [], hasMore: false, nextOffset: 49 }, 50)).toThrow('invalid-cursor');
        expect(() => assertProviderPageProgress({ items: [], hasMore: false, nextOffset: 50 }, 50)).not.toThrow();
    });

    it('does not return a partial list at its finite page bound', async () => {
        const fetchPage = vi.fn(async (offset: number) => ({ items: [], nextOffset: offset + 50, hasMore: true }));
        await expect(collectProviderPages({ fetchPage, getKey: () => 'unused', providerId: 'spotify' }))
            .rejects.toMatchObject({ code: 'invalid-response', providerId: 'spotify', message: expect.stringContaining('page-limit') });
        expect(fetchPage).toHaveBeenCalledTimes(MAX_PROVIDER_PAGES);
    });

    it('discards a late page after cancellation', async () => {
        let cancelled = false;
        const fetchPage = vi.fn(async () => { cancelled = true; return { items: ['late'], nextOffset: 1, hasMore: false }; });
        await expect(collectProviderPages({ fetchPage, getKey: item => item, isCancelled: () => cancelled })).resolves.toBeNull();
    });
});
