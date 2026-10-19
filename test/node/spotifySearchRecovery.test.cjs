'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSearchConnectionRecovery } = require('../../electron/spotify/searchConnectionRecovery.cjs');
// Simulate the real search gate: do not dispatch a query before configuration and handshake complete.
const mismatch = () => Object.assign(Error('old resources'), { code: 'SPOTIFY_RESOURCE_VERSION_CHANGED' });
test('a stale-resource search configures, reconnects, then dispatches the original query', async () => {
  const calls = []; let repaired = false;
  const connect = createSearchConnectionRecovery({
    ensure: async () => { calls.push('handshake'); if (!repaired) throw mismatch(); },
    repair: async () => { calls.push('configure'); repaired = true; },
  });
  await connect(); calls.push('search:millsage');
  assert.deepEqual(calls, ['handshake', 'configure', 'handshake', 'search:millsage']);
});
test('concurrent searches share one repair and all wait for its completion', async () => {
  let release, repaired = false, repairs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const connect = createSearchConnectionRecovery({ ensure: async () => { if (!repaired) throw mismatch(); },
    repair: async () => { repairs++; await gate; repaired = true; } });
  const first = connect(), second = connect(); assert.equal(first, second);
  await Promise.resolve(); assert.equal(repairs, 1); release(); await Promise.all([first, second]);
});
test('a failed repair preserves the cause and a later retry really tries again', async () => {
  let repairs = 0, repaired = false; const events = [];
  const original = Object.assign(Error('vendor apply failed'), { code: 'SPOTIFY_CONFIGURE_CLI_FAILED' });
  const connect = createSearchConnectionRecovery({ ensure: async () => { if (!repaired) throw mismatch(); },
    repair: async () => { if (++repairs === 1) throw original; repaired = true; }, log: (event, facts) => events.push(facts) });
  await assert.rejects(connect(), error => error === original);
  await connect(); assert.equal(repairs, 2);
  assert.equal(events[1].originalCode, 'SPOTIFY_RESOURCE_VERSION_CHANGED');
  assert.equal(events[1].code, 'SPOTIFY_CONFIGURE_CLI_FAILED');
});
test('healthy and rate-limited requests never rebuild resources', async () => {
  let repairs = 0;
  await createSearchConnectionRecovery({ ensure: async () => {}, repair: async () => { repairs++; } })();
  const error = Object.assign(Error('limited'), { code: 'SEARCH_RATE_LIMITED' });
  await assert.rejects(createSearchConnectionRecovery({ ensure: async () => { throw error; }, repair: async () => { repairs++; } })(), e => e === error);
  assert.equal(repairs, 0);
});
test('guide repair awaits installer failure and returns its concrete code', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-search-repair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let checks = 0;
  const guide = require('../../electron/spotify/desktopSetupGuide.cjs').createGuide({ directory,
    resolveBundle: async () => { checks++; throw Object.assign(Error('offline'), { code: 'SPOTIFY_COMPONENT_UPDATE_CHECK_FAILED' }); },
    desktop: { inspect: async () => { throw Object.assign(Error('discovery'), { code: 'SPOTIFY_DISCOVERY_FAILED' }); } }, log: () => {},
  });
  await assert.rejects(guide.repairResources(), { code: 'SPOTIFY_DISCOVERY_FAILED', stage: 'checking' });
  await assert.rejects(guide.repairResources(), { code: 'SPOTIFY_DISCOVERY_FAILED', stage: 'checking' });
  assert.equal(checks, 0);
});
test('resource repair bypasses app upgrade but ordinary installation still checks it', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-resource-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const state = { installations: [{}], selected: 'store', engine: true, cli: true, driver: true, driverEndpointsReady: true, wrapper: false, extension: false, connected: false };
  const installer = require('../../electron/spotify/componentInstall.cjs').createComponentInstall({ directory,
    inspect: async () => state,
    checkLatest: async () => { calls.push('check-upgrade'); throw Object.assign(Error('different native build'), { code: 'SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED' }); },
    prepareConfiguration: async () => calls.push('stop'),
    configureSpicetify: async () => { calls.push('new-resources'); state.wrapper = state.extension = true; },
    connect: async () => { calls.push('connect'); state.connected = true; },
  });
  installer.start('configure', { refreshResources: true }); await installer.settled();
  assert.equal((await installer.status()).phase, 'complete');
  assert.deepEqual(calls, ['stop', 'new-resources', 'connect']);
  installer.start('install', { refreshResources: true }); await installer.settled();
  assert.equal((await installer.status()).code, 'SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED');
  assert.equal((await installer.status()).failureStage, 'checking-updates');
  assert.match((await installer.status()).detail, /音频组件不配套/);
});
