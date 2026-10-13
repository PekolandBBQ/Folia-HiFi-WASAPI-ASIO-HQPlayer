import { OnlineProviderError } from '../../types/onlineMusic';
import type { OnlineProviderId, ProviderPage } from '../../types/onlineMusic';

// src/services/onlineMusic/providerPagination.ts

export const MAX_PROVIDER_PAGES = 1000;

export const paginationFailure = (reason: 'invalid-cursor' | 'page-limit' | 'repeated-page', providerId?: OnlineProviderId) => (
    new OnlineProviderError('invalid-response', `Online collection pagination: ${reason}`, providerId)
);

// Empty normalized pages can consume raw rows; only the provider cursor defines progress.
export const assertProviderPageProgress = <T>(page: ProviderPage<T>, offset: number, providerId?: OnlineProviderId): void => {
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset
        || ((page.hasMore || page.items.length > 0) && page.nextOffset === offset)) {
        throw paginationFailure('invalid-cursor', providerId);
    }
};

// Collects complete library pages, retaining old snapshots when the provider stalls or hits the bound.
export const collectProviderPages = async <T>({
    fetchPage, getKey, isCancelled = () => false, providerId, onPage,
}: {
    fetchPage: (offset: number) => Promise<ProviderPage<T>>;
    getKey: (item: T) => string;
    isCancelled?: () => boolean;
    providerId?: OnlineProviderId;
    onPage?: (observation: { offset: number; page: ProviderPage<T>; duplicateCount: number }) => void;
}): Promise<T[] | null> => {
    const items: T[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (let pageIndex = 0; pageIndex < MAX_PROVIDER_PAGES; pageIndex++) {
        if (isCancelled()) return null;
        const page = await fetchPage(offset);
        if (isCancelled()) return null;
        assertProviderPageProgress(page, offset, providerId);
        let duplicateCount = 0;
        for (const item of page.items) {
            const key = getKey(item);
            if (!seen.has(key)) { seen.add(key); items.push(item); }
            else duplicateCount++;
        }
        try { onPage?.({ offset, page, duplicateCount }); } catch { /* Passive observation cannot change pagination. */ }
        offset = page.nextOffset;
        if (!page.hasMore) return items;
    }
    throw paginationFailure('page-limit', providerId);
};
