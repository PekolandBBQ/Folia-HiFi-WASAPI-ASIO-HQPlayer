import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertLiveFoliaDevServer, assertColdFoliaModuleGraph, unregisterPreviewServiceWorkers, submitHomeSearch } from './foliaAppTestReadiness.mjs';

// Observe the real controlled home input and form submission without playing audio or resetting credentials.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const report = { startedAt: new Date().toISOString(), cases: [] };
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000, env: { ...process.env } });
let page;
try {
    await assertLiveFoliaDevServer();
    for (let attempt = 0; attempt < 120 && !page; attempt++) {
        page = app.windows().find(window => window.url().startsWith('http://localhost:3000'));
        if (!page) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!page) throw new Error('App page unavailable');
    report.unregisteredPreviewWorkers = await unregisterPreviewServiceWorkers(page);
    const qqErrors = [];
    page.on('console', message => {
        if (message.type() === 'error' && message.text().startsWith('[QQMusic] Search failed:')) qqErrors.push(message.text().slice(0, 300));
    });
    await page.evaluate(() => {
        for (const [key, value] of Object.entries({ i18nextLng: 'en', open_player_on_launch: 'false',
            static_mode: 'true', folia_last_seen_ponder_onboarding_version: '0.7.12', folia_native_audio_backend: 'browser',
            folia_native_audio_device: '', folia_native_audio_auto_fallback: 'false' })) localStorage.setItem(key, value);
    });
    await page.reload(); await page.waitForTimeout(15000);
    report.runtimeIdentity = await assertColdFoliaModuleGraph(page);
    report.runtime = await page.evaluate(async () => ({ scripts: [...document.scripts].map(script => script.src).filter(Boolean),
        worker: navigator.serviceWorker?.controller?.scriptURL,
        registrations: (await navigator.serviceWorker?.getRegistrations())?.map(registration => registration.active?.scriptURL) }));
    await page.evaluate(async () => {
        const { useSearchNavigationStore: search } = await import('/src/stores/useSearchNavigationStore.ts');
        const { useOnlineProviderAccountStore: account } = await import('/src/stores/useOnlineProviderAccountStore.ts');
        const { usePlaybackStore: player } = await import('/src/stores/usePlaybackStore.ts');
        const trace = [];
        const record = value => { trace.push({ time: performance.now(), ...value }); if (trace.length > 200) trace.shift(); };
        search.subscribe(state => record({ type: 'state', query: state.searchQuery, provider: state.searchSourceTab,
            searching: state.isSearching, open: state.isSearchOpen, count: state.searchResults?.length, error: state.searchError }));
        for (const type of ['input', 'change', 'keydown', 'submit']) document.addEventListener(type, event => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement || target instanceof HTMLFormElement)) return;
            record({ type, value: target instanceof HTMLInputElement ? target.value : target.querySelector('input')?.value,
                placeholder: target.getAttribute('placeholder'), key: event.key, prevented: event.defaultPrevented,
                trusted: event.isTrusted, target: target.tagName, focused: document.activeElement === target });
        }, true);
        const fetchSource = window.fetch.bind(window);
        window.fetch = async (...args) => {
            const response = await fetchSource(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            if (url.startsWith('https://u.y.qq.com/cgi-bin/musicu.fcg') && typeof args[1]?.body === 'string') {
                const payload = JSON.parse(args[1].body);
                if (payload.request?.method === 'DoSearchForQQMusicLite') {
                    const raw = await response.clone().json();
                    record({ type: 'provider-response', provider: 'qq', httpStatus: response.status,
                        code: raw.code, requestCode: raw.request?.code, dataFields: Object.keys(raw.request?.data || {}),
                        bodyFields: Object.keys(raw.request?.data?.body || {}),
                        itemSongCount: raw.request?.data?.body?.item_song?.length });
                }
            }
            return response;
        };
        window.searchProbe = { search, account, player, trace };
    });
    const cases = [['netease', 'HIMEHINA'], ['qq', '许嵩'], ['qq', '许嵩'], ['netease', 'HIMEHINA']];
    for (const [provider, query] of cases) {
        const result = { provider, query }; report.cases.push(result);
        const login = await page.evaluate(async provider => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            try { return { authenticated: Boolean((await omni.getLoginStatus(provider))?.id) }; }
            catch (error) { return { authenticated: false, error: error.code || 'login-check-failed' }; }
        }, provider);
        result.loginBefore = login;
        if (!login.authenticated) { result.outcome = 'blocked-login'; continue; }
        if (await page.evaluate(() => location.hash === '#player' || location.hash.startsWith('#search'))) await page.keyboard.press('Escape');
        await page.evaluate(provider => {
            const q = window.searchProbe; q.trace.length = 0;
            q.player.getState().setPlayerState('PAUSED'); q.account.getState().setActiveProviderId(provider);
            q.search.getState().resetRuntime(provider);
        }, provider);
        await page.waitForFunction(provider => window.searchProbe.search.getState().searchSourceTab === provider, provider);
        const input = page.getByPlaceholder('SEARCH DATABASE...', { exact: true });
        result.beforeFill = await page.evaluate(() => ({ hash: location.hash, query: window.searchProbe.search.getState().searchQuery,
            inputs: [...document.querySelectorAll('input')].map(input => ({ placeholder: input.placeholder, value: input.value })) }));
        await input.fill(query);
        result.afterFill = await page.evaluate(() => ({ query: window.searchProbe.search.getState().searchQuery,
            value: document.activeElement?.value, focused: document.activeElement?.tagName }));
        await submitHomeSearch(page, provider, query, 'searchProbe');
        await page.waitForTimeout(2000);
        result.afterEnter = await page.evaluate(() => {
            const s = window.searchProbe.search.getState();
            return { hash: location.hash, query: s.searchQuery, provider: s.searchSourceTab, searching: s.isSearching,
                count: s.searchResults?.length, error: s.searchError, trace: window.searchProbe.trace };
        });
        result.qqErrors = [...qqErrors];
        result.loginAfter = await page.evaluate(async provider => {
            const { omni } = await import('/src/services/onlineMusic/omni.ts');
            try { return { authenticated: Boolean((await omni.getLoginStatus(provider))?.id) }; }
            catch (error) { return { authenticated: false, error: error.code || 'login-check-failed' }; }
        }, provider);
        console.log(JSON.stringify(result));
    }
} catch (error) { report.error = String(error.message); }
finally {
    await app.close(); await mkdir(directory, { recursive: true }); report.finishedAt = new Date().toISOString();
    const file = path.join(directory, `app-search-probe-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(report, null, 2)); console.log(file);
}
