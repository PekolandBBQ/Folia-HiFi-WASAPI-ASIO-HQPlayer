'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
// Real vault with generated fake session, deliberately controlled refresh-threshold crossing.
process.env.FOLIA_NATIVE_FIXTURE_DIRECTORY ||= '/workspace/scratch/d96e392874a5/folia-rebuild-r34/source-lifecycle/final-test-snapshot/native';
const { fixture, OTHER, delay } = require('./source-fixture.cjs');
(async () => {
  const f = await fixture({ nativeBridge: true, realSetup: true, sharedMetadata: true, realVault: true });
  const active = await f.start();
  let releaseStarted = false, crossed = false, openScopes;
  const scopeGate = new Promise(resolve => { openScopes = resolve; });
  const tokenCalls = [], originalToken = f.vault.token;
  f.vault.token = async options => { tokenCalls.push({ atMs: performance.now(), allowRefresh: options?.allowRefresh !== false }); return originalToken(options); };
  if (process.argv[3] === 'after-snapshots') openScopes();
  if (process.argv[3] === 'before-old') { f.advanceVault(60000); openScopes(); crossed = true; }
  const originalScopes = f.vault.grantedScopes;
  f.vault.grantedScopes = async () => { await scopeGate; return originalScopes(); };
  f.hooks.native = async operation => { if (operation === 'release') releaseStarted = true; };
  f.hooks.http = async ({ operation }) => {
    if (operation === 'state' && releaseStarted && !crossed) {
      crossed = true; f.advanceVault(60000); openScopes(); await delay(30);
    }
  };
  const at = performance.now(); let value, failure;
  try { value = await f.prepare(OTHER); } catch (error) { failure = { code: error.code, message: error.message }; }
  const result = { application: process.env.FOLIA_SOURCE_TEST_APP, passed: !!value, failure, durationMs: performance.now()-at,
    tokenCalls, refreshes: f.refreshes, native: f.bridge.transcript, requests: f.requests, events: f.events };
  fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, failure, refreshes: result.refreshes.length,
    restores: result.native.filter(e => e.type === 'native-result' && e.operation === 'release').map(e => ({ atMs:e.atMs,state:e.value.state,exact:e.value.exactOriginalRolesRestored })),
    refreshAt: result.refreshes.map(e=>e.atMs) }));
  await active.reader.return(); await f.close();
})().catch(error => { console.error(error); process.exit(1); });
