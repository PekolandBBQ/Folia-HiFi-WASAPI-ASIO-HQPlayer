// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { useSearchNavigationStore, type SearchSource } from '@/stores/useSearchNavigationStore';
import { useBravaisHomeChrome, type BravaisHomeChrome } from '@/library/suites/bravais/useBravaisHomeChrome';

// test/unit/library/bravais/useBravaisHomeChrome.test.ts
// Exercise the seam callback through the real search store, including provider selection and history ordering.
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { searchProviderSongs: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let chrome: BravaisHomeChrome;
let commit: ReturnType<typeof vi.fn<(query: string, source: SearchSource) => void>>;
const request = vi.mocked(omni.searchProviderSongs);
const Probe = ({ source }: { source: SearchSource }) => {
    chrome = useBravaisHomeChrome({
        tab: source === 'local' ? 'local' : source === 'navidrome' ? 'navidrome' : 'playlist',
        tabs: [], selectTab: () => true, scanPercent: 0, scanning: false, searchSource: source,
        props: {
            localSongs: [], localLibraryCatalog: { entities: [], assignments: [], ready: true, reload: async () => {} },
            onSearchCommitted: commit, onBackToPlayer: () => {},
        },
    });
    return null;
};
const render = (source: SearchSource) => act(() => root.render(createElement(Probe, { source })));

beforeEach(() => {
    request.mockReset().mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
    useSearchNavigationStore.getState().resetRuntime('netease');
    useSearchNavigationStore.setState({ searchCache: {} });
    commit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Bravais home search dispatch', () => {
    it('requests the selected QQ provider once and caches results before committing history', async () => {
        let complete!: (value: Awaited<ReturnType<typeof omni.searchProviderSongs>>) => void;
        request.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        render('qq');
        const pending = chrome.search.onSubmit('  晴天  ');
        expect(request).toHaveBeenCalledExactlyOnceWith('qq', '晴天', { limit: 30, offset: 0 });
        expect(commit).not.toHaveBeenCalled();
        expect(useSearchNavigationStore.getState().isSearching).toBe(true);
        const items = [{ id: 1, name: '晴天' }] as Awaited<ReturnType<typeof omni.searchProviderSongs>>['items'];
        complete({ items, hasMore: false, nextOffset: 1 });
        await act(async () => { await pending; });
        expect(commit).toHaveBeenCalledExactlyOnceWith('晴天', 'qq');
        useSearchNavigationStore.getState().restoreSearch({ query: '晴天', sourceTab: 'qq' });
        expect(useSearchNavigationStore.getState().searchResults).toEqual(items);
    });
    it('uses the latest selected provider even when the seam retains its callback', async () => {
        render('qq');
        const submit = chrome.search.onSubmit;
        render('netease');
        await act(async () => { await submit('test'); });
        expect(request).toHaveBeenCalledExactlyOnceWith('netease', 'test', { limit: 30, offset: 0 });
        expect(commit).toHaveBeenCalledExactlyOnceWith('test', 'netease');
    });
    it('searches the local catalog without dispatching an online request', async () => {
        render('local');
        await act(async () => { await chrome.search.onSubmit('local'); });
        expect(request).not.toHaveBeenCalled();
        expect(commit).toHaveBeenCalledExactlyOnceWith('local', 'local');
        expect(useSearchNavigationStore.getState().searchResults).toEqual([]);
    });
    it('does not commit an empty query and preserves a failed request for the result page', async () => {
        render('qq');
        await act(async () => { await chrome.search.onSubmit('  '); });
        expect(request).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        request.mockRejectedValue(new Error('search_unavailable'));
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await act(async () => { await chrome.search.onSubmit('test'); });
            expect(commit).toHaveBeenCalledExactlyOnceWith('test', 'qq');
            useSearchNavigationStore.getState().restoreSearch({ query: 'test', sourceTab: 'qq' });
            expect(useSearchNavigationStore.getState().searchError).toBe('search_unavailable');
        } finally { log.mockRestore(); }
    });
});
