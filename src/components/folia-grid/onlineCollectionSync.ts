import { appendUniqueByKey } from './progressiveGrid';
import { assertProviderPageProgress, MAX_PROVIDER_PAGES, paginationFailure } from '../../services/onlineMusic/providerPagination';

// src/components/folia-grid/onlineCollectionSync.ts
// Background paging for large online collections (GridView fills the rest after the first page).
//
// 进度按上游的原始 offset 推进，而不是按去重后的条数：上游歌单里可能有重复条目，
// 拿去重后的长度去比 total 永远到不了终点，只能白跑请求直到撞上安全上限。
// 单页失败先按退避重试，还失败才把中断点交回调用方，由界面决定怎么展示和续传。

export type CollectionSyncPage<T> = {
    items: T[];
    total?: number;
    hasMore: boolean;
    nextOffset: number;
    preserveDuplicates?: boolean;
};

export type CollectionSyncResult<T> =
    | { status: 'complete'; items: T[]; offset: number }
    | { status: 'failed'; items: T[]; offset: number; error: unknown }
    | { status: 'cancelled'; items: T[]; offset: number };

export type CollectionSyncOptions<T> = {
    initialItems: T[];
    /** Raw upstream offset to continue from; duplicates make it differ from `initialItems.length`. */
    startOffset: number;
    total?: number;
    fetchPage: (offset: number) => Promise<CollectionSyncPage<T>>;
    getKey: (item: T) => string;
    /** Checked after every await; a newer sync or an unmount makes the old one stop quietly. */
    isCancelled: () => boolean;
    onPage: (items: T[], offset: number, hasMore: boolean) => void;
    wait?: (ms: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
};

export const COLLECTION_SYNC_PAGE_INTERVAL_MS = 100;
export const COLLECTION_SYNC_RETRY_DELAYS_MS = [500, 1500, 4000] as const;
// A broken provider remains bounded even if it invents advancing offsets and totals.

const defaultWait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class SyncCancelled extends Error {}

// Shared by the first page, manual paging and background sync; never infer a cursor from item count.
export const mergeCollectionPage = <T>(items: T[], offset: number, page: CollectionSyncPage<T>, getKey: (item: T) => string) => {
    assertProviderPageProgress(page, offset);
    return { items: page.preserveDuplicates ? [...items, ...page.items] : appendUniqueByKey(items, page.items, getKey), offset: page.nextOffset, hasMore: page.hasMore };
};

// Fetches one page, retrying with backoff; throws the last error once retries run out.
const fetchPageWithRetry = async <T>(
    offset: number,
    options: CollectionSyncOptions<T>,
    wait: (ms: number) => Promise<void>,
): Promise<CollectionSyncPage<T>> => {
    const retryDelays = options.retryDelaysMs ?? COLLECTION_SYNC_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            return await options.fetchPage(offset);
        } catch (error) {
            if (options.isCancelled()) throw new SyncCancelled();
            if (attempt >= retryDelays.length) throw error;
            console.warn(`Collection sync page at offset ${offset} failed, retrying (${attempt + 1}/${retryDelays.length})`, error);
            await wait(retryDelays[attempt]);
            if (options.isCancelled()) throw new SyncCancelled();
        }
    }
};

// Pages until the provider ends continuation; filtered rows and stale totals cannot end it early.
export const syncRemainingCollectionPages = async <T>(
    options: CollectionSyncOptions<T>,
): Promise<CollectionSyncResult<T>> => {
    const wait = options.wait ?? defaultWait;
    let total = options.total;
    let items = options.initialItems;
    let offset = options.startOffset;

    for (let pageIndex = 0; pageIndex < MAX_PROVIDER_PAGES; pageIndex++) {
        await wait(COLLECTION_SYNC_PAGE_INTERVAL_MS);
        if (options.isCancelled()) return { status: 'cancelled', items, offset };

        let page: CollectionSyncPage<T>;
        try {
            page = await fetchPageWithRetry(offset, options, wait);
        } catch (error) {
            if (error instanceof SyncCancelled || options.isCancelled()) {
                return { status: 'cancelled', items, offset };
            }
            return { status: 'failed', items, offset, error };
        }
        if (options.isCancelled()) return { status: 'cancelled', items, offset };
        const previousLength = items.length;
        try {
            const merged = mergeCollectionPage(items, offset, page, options.getKey);
            items = merged.items;
            offset = merged.offset;
        } catch (error) {
            return { status: 'failed', items, offset, error };
        }
        total = page.total ?? total;
        options.onPage(items, offset, page.hasMore);

        if (!page.hasMore) return { status: 'complete', items, offset };
        // 没有 total 时，一整页都是旧条目通常说明上游忽略了 offset，继续翻只会原地打转。
        if (!page.preserveDuplicates && total === undefined && page.items.length > 0 && items.length === previousLength) {
            return { status: 'failed', items, offset, error: paginationFailure('repeated-page') };
        }
    }

    return { status: 'failed', items, offset, error: paginationFailure('page-limit') };
};
