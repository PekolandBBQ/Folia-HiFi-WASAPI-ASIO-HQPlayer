// Require live development source: an offline PWA shell cannot validate freshly edited modules.
export async function assertLiveFoliaDevServer() {
    const response = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    const html = await response.text();
    if (!response.ok || !html.includes('/@vite/client') || !html.includes('/src/index.tsx'))
        throw new Error('Live Folia Vite source is unavailable; cached app UI is not valid regression evidence');
}

export async function unregisterPreviewServiceWorkers(page) {
    return page.evaluate(async () => {
        const registrations = await navigator.serviceWorker?.getRegistrations() || [];
        for (const registration of registrations) await registration.unregister();
        return registrations.length;
    });
}

// Install before a fresh renderer navigation: the default 250-entry resource
// buffer cannot establish module identity for this application's full graph.
// Only local source paths and the presence of an HMR timestamp are retained.
export async function observeFreshFoliaModuleGraph(page) {
    await page.addInitScript(() => {
        performance.setResourceTimingBufferSize(16384);
        const state = { records: [], overflow: false };
        Object.defineProperty(window, '__foliaColdModuleObservation', { value: state });
        performance.addEventListener('resourcetimingbufferfull', () => { state.overflow = true; });
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                let url; try { url = new URL(entry.name); } catch { continue; }
                if (url.origin !== location.origin) continue;
                const source = url.pathname.startsWith('/src/')
                    || url.pathname.startsWith('/@fs/') && /\/folia-exclusive\/src\//i.test(url.pathname);
                if (!source || !/\.(?:[cm]?[jt]sx?)$/i.test(url.pathname)) continue;
                if (state.records.length >= 8192) { state.overflow = true; continue; }
                state.records.push({ path: url.pathname, timestamped: url.searchParams.has('t') });
            }
        });
        observer.observe({ type: 'resource', buffered: true });
    });
    await unregisterPreviewServiceWorkers(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
}

// Bare dynamic test imports must share the JS/TS modules used by the mounted
// app. CSS hot refresh replaces styles without creating a second store or
// service identity; its visible styling is still covered by UI assertions.
export async function assertColdFoliaModuleGraph(page) {
    const observed = await page.evaluate(() => {
        const value = window.__foliaColdModuleObservation;
        return value ? { overflow: value.overflow, count: value.records.length,
            variants: value.records.filter(entry => entry.timestamped).map(entry => entry.path) } : null;
    });
    if (observed) {
        if (observed.overflow || !observed.count) throw new Error('Folia module observation is incomplete');
        if (observed.variants.length) throw new Error(`Folia App uses HMR module variants; restart the Vite server before direct-import acceptance probes: ${observed.variants.slice(0, 4).join(', ')}`);
        return { coldModuleGraph: true, completeResourceObservation: true, observedSourceScripts: observed.count };
    }
    const timestamped = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name))
        .filter(url => url.pathname.startsWith('/src/') && url.searchParams.has('t'))
        .map(url => `${url.pathname}${url.search}`));
    const variants = timestamped.filter(url => /\.(?:[cm]?[jt]sx?)$/i.test(url.split('?')[0]));
    if (variants.length) throw new Error(`Folia App uses HMR module variants; restart the Vite server before direct-import acceptance probes: ${variants.slice(0, 4).join(', ')}`);
    return { coldModuleGraph: true };
}

export async function submitHomeSearch(page, provider, query, readStateKey) {
    const input = page.getByPlaceholder('SEARCH DATABASE...', { exact: true });
    await input.fill(query);
    // Confirm that the trusted input event reached the store used by the mounted app, before submitting its form.
    await page.waitForFunction(({ provider, query, readStateKey }) => {
        const search = window[readStateKey].search.getState();
        const field = document.querySelector('input[placeholder="SEARCH DATABASE..."]');
        return search.searchQuery === query && search.searchSourceTab === provider && field?.value === query;
    }, { provider, query, readStateKey }, { timeout: 5000 });
    await input.press('Enter');
}
