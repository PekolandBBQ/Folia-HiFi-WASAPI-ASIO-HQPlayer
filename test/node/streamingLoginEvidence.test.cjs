const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

// No App, network or VM: run the observer callbacks and exact authentication observer with fixtures.
const helpers = Promise.all([import('../manual/neteaseLoginEvidence.mjs'), import('../manual/foliaAppTestReadiness.mjs')]);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function authFixture({ login, account, reject, mutate, after } = {}) {
    let cookie = 'fixture-secret-cookie';
    const initialLogin = login ?? { code: 200, data: { code: 200, profile: { userId: 947503910, nickname: 'private-name' }, account: { id: 947503910 } }, cookie };
    const initialAccount = account ?? { code: 200, profile: { userId: 947503910 }, account: { id: 947503910 } };
    const observedCalls = [];
    const api = {
        async getLoginStatus(session) { observedCalls.push(['login', session]); if (reject) throw reject; return initialLogin; },
        async getUserAccount(session) { observedCalls.push(['account', session]); if (mutate) cookie = 'new-fixture-cookie'; return initialAccount; },
    };
    const originalLogin = api.getLoginStatus, originalAccount = api.getUserAccount;
    const omni = { async getLoginStatus() {
        const session = { cookie };
        const one = await api.getLoginStatus(session);
        if (one?.data?.code === 301 || one?.code === 301) return null;
        const two = await api.getUserAccount(session);
        if (after) await after(api);
        return two?.profile ? { id: two.profile.userId, nickname: two.profile.nickname || '' } : null;
    } };
    return { api, omni, readSession: () => cookie, observedCalls, originalLogin, originalAccount };
}
test('observes the exact same-session Omni responses and emits only safe projections', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers, fixture = authFixture();
    const result = await checkNeteaseLoginWithEvidence(fixture);
    assert.equal(result.authenticated, true); assert.equal(result.omniAuthenticated, true);
    assert.equal(result.diagnostics.identitiesMatch, true); assert.equal(result.diagnostics.sameCapturedSession, true);
    assert.equal(result.diagnostics.login.code, 200); assert.equal(result.diagnostics.login.profilePresent, true);
    assert.equal(result.diagnostics.account.accountPresent, true);
    assert.equal(fixture.observedCalls.length, 2); assert.equal(fixture.observedCalls[0][1], fixture.observedCalls[1][1]);
    assert.equal(fixture.api.getLoginStatus, fixture.originalLogin); assert.equal(fixture.api.getUserAccount, fixture.originalAccount);
    const encoded = JSON.stringify(result);
    for (const forbidden of ['947503910', 'private-name', 'fixture-secret-cookie', 'http', 'userId', 'cookie']) assert.equal(encoded.includes(forbidden), false);
});
test('explicit rejection is preserved without an account retry', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers, fixture = authFixture({ login: { code: 200, data: { code: 301, profile: null } } });
    const result = await checkNeteaseLoginWithEvidence(fixture);
    assert.equal(result.authenticated, false); assert.equal(result.diagnostics.login.nestedCode, 301);
    assert.equal(result.diagnostics.account.observed, false); assert.equal(fixture.observedCalls.length, 1);
});
test('rejects missing identity facts, mismatch and session rotation as unverified', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers;
    for (const options of [{ account: { code: 200, profile: { userId: 8 }, account: { id: 8 } } },
        { login: { code: 200, data: { code: 200, profile: {} } } }, { mutate: true }]) {
        const result = await checkNeteaseLoginWithEvidence(authFixture(options));
        assert.equal(result.authenticated, false); assert.equal(result.errorCode, 'login-observation-unverified');
        assert.equal(result.diagnostics.observationComplete, true);
    }
});
test('restores originals on rejection without leaking raw error message or arbitrary code', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers;
    const fixture = authFixture({ reject: Object.assign(new Error('secret-cookie https://private.test/account'), { code: 'spak_fixture_secret' }) });
    const result = await checkNeteaseLoginWithEvidence(fixture);
    assert.equal(result.errorCode, 'login-check-failed'); assert.equal(result.diagnostics.login.errorCode, 'login-check-failed');
    assert.equal(fixture.api.getLoginStatus, fixture.originalLogin); assert.equal(fixture.api.getUserAccount, fixture.originalAccount);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('excludes a concurrent library refresh using a different session object', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers, gate = deferred();
    const fixture = authFixture({ after: async () => { await gate.promise; } });
    const attempt = checkNeteaseLoginWithEvidence(fixture);
    await new Promise(resolve => setImmediate(resolve));
    await fixture.api.getLoginStatus({ cookie: 'foreign-fixture-session' });
    await fixture.api.getUserAccount({ cookie: 'foreign-fixture-session' });
    gate.resolve(); const result = await attempt;
    assert.equal(result.authenticated, true); assert.equal(result.diagnostics.identitiesMatch, true);
    assert.equal(result.diagnostics.sameCapturedSession, true); assert.equal(fixture.observedCalls.length, 4);
});
test('keeps a later decorator installed rather than overwriting another observer', async () => {
    const [{ checkNeteaseLoginWithEvidence }] = await helpers;
    const replacement = async () => ({ replacement: true });
    const fixture = authFixture({ after: async api => { api.getUserAccount = replacement; } });
    await checkNeteaseLoginWithEvidence(fixture); assert.equal(fixture.api.getUserAccount, replacement);
});
function observerPage(entries, { bufferFull = false } = {}) {
    let initializer, callback, bufferSize, observeOptions, events = {}, reloads = 0;
    const sandbox = { window: {}, URL, location: { origin: 'http://localhost:3000' },
        navigator: { serviceWorker: { getRegistrations: async () => [] } },
        performance: { setResourceTimingBufferSize: value => { bufferSize = value; }, addEventListener: (name, handler) => { events[name] = handler; } },
        PerformanceObserver: class { constructor(fn) { callback = fn; } observe(options) { observeOptions = options; } } };
    const context = vm.createContext(sandbox);
    const page = { addInitScript: async fn => { initializer = fn; },
        evaluate: async fn => vm.runInContext(`(${fn.toString()})()`, context),
        reload: async () => { reloads++; await page.evaluate(initializer); callback({ getEntries: () => entries }); if (bufferFull) events.resourcetimingbufferfull(); } };
    return { page, info: () => ({ bufferSize, observeOptions, reloads }) };
}
test('fresh observation captures the full graph beyond 250 entries and strips query payloads', async () => {
    const [, { observeFreshFoliaModuleGraph, assertColdFoliaModuleGraph }] = await helpers;
    const entries = Array.from({ length: 700 }, (_, index) => ({ name: `http://localhost:3000/src/module${index}.ts?secret=fixture-private-value` }));
    const fixture = observerPage(entries); await observeFreshFoliaModuleGraph(fixture.page);
    const result = await assertColdFoliaModuleGraph(fixture.page);
    assert.equal(result.completeResourceObservation, true); assert.equal(result.observedSourceScripts, 700);
    assert.equal(fixture.info().bufferSize, 16384); assert.equal(fixture.info().reloads, 1);
    assert.equal(fixture.info().observeOptions.buffered, true);
    assert.equal(JSON.stringify(await fixture.page.evaluate(() => window.__foliaColdModuleObservation)).includes('fixture-private-value'), false);
});
test('rejects an HMR script variant after the old default resource-buffer boundary', async () => {
    const [, { observeFreshFoliaModuleGraph, assertColdFoliaModuleGraph }] = await helpers;
    const entries = Array.from({ length: 700 }, (_, index) => ({ name: `http://localhost:3000/src/module${index}.ts${index === 699 ? '?t=123' : ''}` }));
    const fixture = observerPage(entries); await observeFreshFoliaModuleGraph(fixture.page);
    await assert.rejects(assertColdFoliaModuleGraph(fixture.page), /module699.ts/);
});
test('keeps strict record, global resource-buffer and empty-graph bounds', async () => {
    const [, { observeFreshFoliaModuleGraph, assertColdFoliaModuleGraph }] = await helpers;
    const many = Array.from({ length: 8193 }, (_, index) => ({ name: `http://localhost:3000/src/a${index}.js` }));
    for (const fixture of [observerPage(many), observerPage([{ name: 'http://localhost:3000/src/a.ts' }], { bufferFull: true }), observerPage([])]) {
        await observeFreshFoliaModuleGraph(fixture.page);
        await assert.rejects(assertColdFoliaModuleGraph(fixture.page), /incomplete/);
    }
});
test('observes @fs scripts and permits CSS hot refresh without a duplicate script identity', async () => {
    const [, { observeFreshFoliaModuleGraph, assertColdFoliaModuleGraph }] = await helpers;
    const fixture = observerPage([{ name: 'http://localhost:3000/src/main.ts' }, { name: 'http://localhost:3000/src/index.css?t=1' },
        { name: 'http://external.test/src/foreign.ts?t=1' }, { name: 'http://localhost:3000/@fs/C:/repo/folia-exclusive/src/store.ts?t=1' }]);
    await observeFreshFoliaModuleGraph(fixture.page);
    await assert.rejects(assertColdFoliaModuleGraph(fixture.page), /store.ts/);
    const records = await fixture.page.evaluate(() => window.__foliaColdModuleObservation.records);
    assert.equal(records.length, 2);
});
test('the real output harness requires complete fresh observation both before and after cases', async () => {
    const source = await readFile(path.join(__dirname, '../manual/spotifyAppOutputRegression.mjs'), 'utf8');
    assert.match(source, /await observeFreshFoliaModuleGraph\(page\)/);
    assert.match(source, /report\.runtimeIdentity\.completeResourceObservation/);
    assert.match(source, /report\.runtimeIdentityAfter\.completeResourceObservation/);
});
