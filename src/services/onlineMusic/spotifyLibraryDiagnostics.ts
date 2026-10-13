import type { ProviderCollection, ProviderPage } from '../../types/onlineMusic';
import type { SpotifyLibraryDiagnosticFields } from '../../types/privateDiagnostics';
import { getPrivateDiagnosticsApi, nextPrivateDiagnosticRef, recordPrivateDiagnostic } from '../debug/privateDiagnostics';

// src/services/onlineMusic/spotifyLibraryDiagnostics.ts — local-only observations; no API calls or cache writes.
const own = (value: unknown, key: string): any => {
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const tri = (value: unknown) => value === true ? 'yes' as const : value === false ? 'no' as const : 'unknown' as const;
const count = (value: number) => Math.min(100000, Math.max(0, value));
const source = (collection: unknown) => own(collection, 'metadataSource') === 'spotify-api' ? 'api' as const
    : own(collection, 'metadataSource') === 'spotify-public-embed' ? 'public' as const : 'unknown' as const;
const safeError = (error: unknown) => ['auth-required', 'unsupported', 'unavailable', 'network', 'invalid-response'].includes(own(error, 'code')) ? own(error, 'code') : 'UNKNOWN';
const enabled = () => { try { return Boolean(getPrivateDiagnosticsApi()); } catch { return false; } };
function emit(fields: SpotifyLibraryDiagnosticFields) { recordPrivateDiagnostic({ event: 'spotify.library', fields }); }
function itemFields(item: unknown): Partial<SpotifyLibraryDiagnosticFields> {
    const id = own(item, 'id'), data = own(item, 'providerData');
    return { ...(validId(id) ? { playlistId: id } : {}), source: source(item), ownerSelf: tri(own(item, 'isOwned')),
        publicState: tri(own(data, 'public')), collaborativeState: tri(own(data, 'collaborative')) };
}
let normalizationBudget = 0;
// Wrap the existing normalizer, preserving the exact result/error, including whole-page failure on null rows.
export function observeSpotifyLibraryPage<T extends ProviderCollection>(raw: unknown, offset: number, normalize: () => ProviderPage<T>): ProviderPage<T> {
    if (!enabled()) return normalize();
    if (offset === 0) normalizationBudget = 128;
    const report = (fields: SpotifyLibraryDiagnosticFields) => { if (normalizationBudget > 0) { normalizationBudget--; emit({ ...fields, capped: fields.capped === true || normalizationBudget === 0 }); } };
    const rows = own(raw, 'items'), length = Array.isArray(rows) ? rows.length : 0, inspectedCount = Math.min(length, 50);
    let nullCount = 0, invalidCount = 0;
    for (let index = 0; index < inspectedCount; index++) {
        const row = own(rows, String(index));
        if (row == null) nullCount++;
        else if (!validId(own(row, 'id')) || typeof own(row, 'name') !== 'string') invalidCount++;
    }
    const fields = { source: source(raw), pageOffset: count(offset), rawCount: count(length), inspectedCount, nullCount, invalidCount };
    let result: ProviderPage<T>;
    try { result = normalize(); }
    catch (error) { report({ phase: 'normalized-page', ...fields, ok: false, reason: 'invalid-row', errorCode: safeError(error) }); throw error; }
    try {
        report({ phase: 'normalized-page', ...fields, normalizedCount: count(result.items.length), droppedCount: count(length - result.items.length),
            nextOffset: count(result.nextOffset), hasContinuation: result.hasMore, ok: true, capped: length > inspectedCount || normalizationBudget <= result.items.length });
        for (const item of result.items.slice(0, 50)) report({ phase: 'normalized-item', ...itemFields(item) });
    } catch { /* Even a damaged diagnostic bridge cannot change a normalized result. */ }
    return result;
}
// One observer per existing refresh; IDs are sent only as local IPC correlation inputs, never journal fields.
export function createSpotifyLibraryObservation(providerId: string, before: ProviderCollection[] = []) {
    const active = providerId === 'spotify' && enabled(), refreshRef = active ? nextPrivateDiagnosticRef() : undefined;
    let budget = 256;
    const report = (fields: SpotifyLibraryDiagnosticFields) => {
        if (!active || budget <= 0 || (budget === 1 && fields.phase !== 'refresh-result')) return;
        budget--; emit({ ...fields, refreshRef, capped: fields.capped === true || budget <= 1 });
    };
    const rows = (phase: 'cache-before' | 'cache-after', collections: ProviderCollection[], reason?: SpotifyLibraryDiagnosticFields['reason']) => {
        for (const item of collections.slice(0, 100)) if (!item.isLiked) report({ phase, ...itemFields(item), reason });
    };
    try {
        if (active) {
            report({ phase: 'refresh-start', source: 'cache', beforeCount: count(before.length), capped: before.length > 100 });
            rows('cache-before', before);
        }
    } catch { /* Cache metadata is never needed for diagnostics. */ }
    return {
        page: ({ offset, page, duplicateCount }: { offset: number; page: ProviderPage<unknown>; duplicateCount: number }) =>
            report({ phase: 'dedup-page', source: 'api', pageOffset: count(offset), normalizedCount: count(page.items.length), duplicateCount: count(duplicateCount),
                nextOffset: count(page.nextOffset), hasContinuation: page.hasMore }),
        replace: (previous: ProviderCollection[], next: ProviderCollection[]) => {
            if (!active) return;
            try {
                const inspectedBefore = previous.slice(0, 1000), inspectedAfter = next.slice(0, 1000);
                const completeComparison = previous.length <= 1000 && next.length <= 1000;
                const nextIds = new Set(inspectedAfter.map(item => own(item, 'id')).filter(validId));
                report({ phase: 'cache-replace', source: 'mixed', reason: 'replaced', beforeCount: count(previous.length), afterCount: count(next.length),
                    publicBeforeCount: inspectedBefore.filter(item => source(item) === 'public').length, publicAfterCount: inspectedAfter.filter(item => source(item) === 'public').length,
                    inspectedCount: inspectedBefore.length + inspectedAfter.length,
                    ...(completeComparison ? { removedCount: inspectedBefore.filter(item => validId(own(item, 'id')) && !nextIds.has(own(item, 'id'))).length } : {}),
                    capped: previous.length > 100 || next.length > 100 });
                for (const item of previous.slice(0, 100)) if (!item.isLiked) report({ phase: 'cache-before', ...itemFields(item), reason: nextIds.has(own(item, 'id')) ? 'retained' : next.length <= 1000 ? 'removed' : 'unknown' });
                rows('cache-after', next);
            } catch { /* Leave the existing cache replacement untouched. */ }
        },
        result: (ok: boolean, facts: Partial<SpotifyLibraryDiagnosticFields> = {}) => report({ phase: 'refresh-result', ok, ...facts }),
    };
}
export function observeSpotifyLibraryHydration(collections: ProviderCollection[], applied: boolean) {
    if (!enabled()) return;
    try {
        emit({ phase: 'hydrate', source: 'cache', afterCount: count(collections.length), ok: applied, capped: collections.length > 100 });
        for (const item of collections.slice(0, 100)) if (!item.isLiked) emit({ phase: 'cache-after', ...itemFields(item), reason: applied ? 'retained' : 'cancelled' });
    } catch { /* Leave the existing hydration untouched. */ }
}
