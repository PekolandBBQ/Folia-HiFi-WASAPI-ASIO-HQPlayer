// src/components/folia-grid/onlineCollectionCache.ts

export const COLLECTION_TRACK_CACHE_SCHEMA_VERSION = 6;

export type CollectionTrackSnapshot<T> = {
    tracks: T[];
    snapshotTime: number;
    schemaVersion: number;
    nextOffset: number;
    hasMore: boolean;
    total?: number;
};

export const createCollectionTrackSnapshot = <T>(tracks: T[], nextOffset: number, hasMore: boolean, snapshotTime: number, total?: number): CollectionTrackSnapshot<T> => ({
    tracks, nextOffset, hasMore, snapshotTime, total, schemaVersion: COLLECTION_TRACK_CACHE_SCHEMA_VERSION,
});

// Old snapshots have no raw cursor or completeness flag and must be refreshed, not resumed by length.
export const readCollectionTrackSnapshot = <T>(value: unknown, targetTime: number): CollectionTrackSnapshot<T> | null => {
    if (!value || typeof value !== 'object' || targetTime <= 0) return null;
    const cached = value as CollectionTrackSnapshot<T>;
    if (cached.schemaVersion !== COLLECTION_TRACK_CACHE_SCHEMA_VERSION || cached.snapshotTime !== targetTime
        || !Array.isArray(cached.tracks) || typeof cached.hasMore !== 'boolean'
        || !Number.isSafeInteger(cached.nextOffset) || cached.nextOffset < cached.tracks.length) return null;
    return cached;
};
