'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
process.env.FOLIA_SOURCE_TEST_APP ||= path.resolve(__dirname, '../..');
process.env.FOLIA_NATIVE_FIXTURE_DIRECTORY ||= '/workspace/scratch/d96e392874a5/folia-rebuild-r34/source-lifecycle/final-test-snapshot/native';
const { fixture, OTHER, delay } = require('./source-fixture.cjs');
const { createCableSpotifyService, registerCableSpotify } = require('../../electron/spotify/cableService.cjs');
const fakeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
const grant = () => ({ access_token: 'synthetic-new-grant', refresh_token: 'synthetic-new-refresh', clientId: 'synthetic-client',
  expiresAt: Date.now() + 2 * 86400000, scope: 'user-read-playback-state user-modify-playback-state' });
const observed = task => task.then(value => ({ value }), error => ({ error }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const lastRelease = f => f.bridge.transcript.filter(value => value.type === 'native-result' && value.operation === 'release').at(-1)?.value;
const mutations = f => f.requests.filter(value => value.method === 'PUT').length;
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push({ code: error.code, message: error.message }));
async function withPaused(name, task) {
  const vaultFile = path.join(process.env.FOLIA_SOURCE_TEST_APP, 'electron/spotify/sessionVault.cjs');
  const vaultHash = createHash('sha256').update(await fs.readFile(vaultFile)).digest('hex');
  const f = await fixture({ nativeBridge: true, realSetup: true, realVault: true }); let failure;
  try {
    const active = await f.start(); await active.source.pause({ positionMs: 17000 }); await active.reader.return();
    assert.ok(f.captures.every(value => value.stopped)); assert.equal(lastRelease(f), undefined);
    const stamp = f.vault.stamp(), requests = f.requests.length, captures = f.captures.length;
    // Only the real vault clock advances; the native proof clock stays real.
    f.advanceVault(86400000); await delay(10);
    assert.equal(f.requests.length, requests); assert.equal(f.captures.length, captures); assert.equal(f.refreshes.length, 0);
    await task(f, active, stamp);
    assert.equal(createHash('sha256').update(await fs.readFile(vaultFile)).digest('hex'), vaultHash, 'vault source must stay frozen during the case');
  } catch (error) { failure = error; throw error; }
  finally {
    await fs.writeFile(path.join(__dirname, 'results', (process.env.FOLIA_VAULT_RESULT_PREFIX || '') + name + '.json'), JSON.stringify({ name, passed: !failure,
      failure: failure && { code: failure.code, message: failure.message, stack: failure.stack },
      refreshes: f.refreshes, events: f.events, requests: f.requests, native: f.bridge.transcript,
      vaultArtifact: { file: vaultFile, sha256: vaultHash },
      jsArtifacts: f.bridge.jsArtifacts, nativeArtifacts: f.bridge.artifacts }, null, 2));
    f.hooks.refresh = null; await f.close();
  }
}
function serviceFor(f) {
  return createCableSpotifyService({ directory: f.setupDirectory, safeStorage: fakeStorage, platform: 'win32',
    fetcher: async () => { throw new Error('No catalog or OAuth request is allowed in the service-close fixture'); },
    createControl: () => f.control, createAudio: () => f.audio, createCaptureHost: () => f.captureHost,
    createSetup: () => f.setup, createRouteHost: () => f.bridge, createRouteLifecycle: () => f.routeLifecycle });
}
async function quitThroughRegistration(f) {
  const app = new EventEmitter(), handlers = new Map(), settled = deferred(), dialogs = [];
  let prevented = 0, quits = 0;
  app.getPath = () => f.setupDirectory;
  app.quit = () => { quits++; settled.resolve(); };
  const service = serviceFor(f);
  registerCableSpotify({ app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isTrustedSender: () => true, createService: () => service, platform: 'win32',
    electron: { safeStorage: fakeStorage, net: { fetch: async () => { throw new Error('External HTTP forbidden'); } }, shell: {},
      dialog: { showMessageBox: async value => { dialogs.push(value); settled.resolve(); } } } });
  // Status creates the runtime without starting another source or opening an authorization flow.
  const initial = await handlers.get('spotify:request')({ sender: { isDestroyed: () => false, send() {} } }, { action: 'playbackSetup', operation: 'status' });
  assert.equal(initial.spotifyError, undefined);
  app.emit('before-quit', { preventDefault: () => { prevented++; } });
  await Promise.race([settled.promise, delay(6000).then(() => { throw new Error('Quit did not reach success or recovery dialog'); })]);
  return { prevented, quits, dialogs, service };
}
test('real vault + C#: Play after day-long held pause refreshes same grant and preserves heard checkpoint', () => withPaused('grant-refresh-paused-play', async (f, active, stamp) => {
  const resumed = await f.resume(active, 17000);
  assert.equal(f.refreshes.length, 1); assert.deepEqual(f.vault.stamp(), stamp);
  assert.equal(resumed.opened.positionMs, 17000); assert.equal(resumed.block.value[0], 2);
  assert.equal(f.requests.filter(value => value.operation === 'select').length, 1);
  await resumed.source.stop(); await resumed.reader.return();
  assert.equal(lastRelease(f).exactOriginalRolesRestored, true);
}));
test('real vault + C#: Stop after day-long held pause refreshes and restores exact original route', () => withPaused('grant-refresh-paused-stop', async (f, active, stamp) => {
  const count = f.captures.length; await active.source.stop();
  assert.equal(f.refreshes.length, 1); assert.deepEqual(f.vault.stamp(), stamp);
  assert.equal(f.captures.length, count); assert.equal(f.state.is_playing, false);
  assert.equal(lastRelease(f).exactOriginalRolesRestored, true); assert.equal(lastRelease(f).globalDefaultsWritten, false);
}));
test('real vault + C#: registered Quit after day-long held pause restores before allowing exit', () => withPaused('grant-refresh-paused-quit', async (f, _active, stamp) => {
  const result = await quitThroughRegistration(f);
  assert.equal(result.prevented, 1); assert.equal(result.quits, 1); assert.deepEqual(result.dialogs, []);
  assert.equal(f.refreshes.length, 1); assert.deepEqual(f.vault.stamp(), stamp);
  assert.equal(lastRelease(f).exactOriginalRolesRestored, true); assert.equal(lastRelease(f).globalDefaultsWritten, false);
}));
test('real vault + C#: next-track speculation tolerates old-owner same-grant refresh and waits for restoration', () => withPaused('grant-refresh-next-track', async (f, _active, stamp) => {
  await f.prepare(OTHER);
  assert.equal(f.refreshes.length, 1); assert.deepEqual(f.vault.stamp(), stamp);
  const released = f.bridge.transcript.filter(value => value.type === 'native-result' && value.operation === 'release').at(-1);
  const nextSelect = f.requests.filter(value => value.operation === 'select').at(-1);
  assert.equal(released.value.exactOriginalRolesRestored, true); assert.ok(released.atMs < nextSelect.startedMs);
  assert.equal(f.captures.length, 1, 'new preparation does not capture or play');
}));
for (const change of ['scope', 'logout', 'concurrent-grant', 'disk-write']) {
  test(`real vault + C#: ${change} cannot resume or authorize retained route restoration`, () => withPaused('grant-refresh-reject-' + change, async (f, active, stamp) => {
    const beforeWrites = mutations(f), beforeCapture = f.captures.length;
    let pending, finish, obstruction;
    if (change === 'scope') f.hooks.refresh = () => Response.json({ access_token: 'synthetic-narrowed', expires_in: 3600, scope: 'user-read-playback-state' });
    if (change === 'logout') await f.vault.clear();
    if (change === 'concurrent-grant') {
      const entered = deferred(), blocked = deferred(); finish = blocked.resolve;
      f.hooks.refresh = async () => { entered.resolve(); await blocked.promise; };
      pending = observed(f.resume(active, 17000)); await entered.promise;
      await f.vault.save(grant()); finish();
    }
    if (change === 'disk-write') {
      obstruction = path.join(f.setupDirectory, 'fake-vault', 'session.enc.tmp');
      await fs.mkdir(obstruction); // Actual fs.writeFile must fail on this directory.
    }
    const result = await (pending || observed(f.resume(active, 17000))); assert.ok(result.error);
    const cleanup = await observed(f.audio.clear()); assert.ok(cleanup.error);
    assert.equal(mutations(f), beforeWrites); assert.equal(f.captures.length, beforeCapture);
    assert.ok(f.captures.every(value => value.stopped)); assert.equal(f.state.is_playing, false);
    const failed = lastRelease(f); assert.equal(failed.state, 'recoveryRequired'); assert.equal(failed.restoreWritesStarted, false);
    assert.equal(failed.exactOriginalRolesRestored, false);
    if (change === 'disk-write') { assert.deepEqual(f.vault.stamp(), stamp); await fs.rm(obstruction, { recursive: true }); }
    else assert.notDeepEqual(f.vault.stamp(), stamp);
  }));
}
test('real vault + C#: changed scope keeps registered Quit open with recovery dialog', () => withPaused('grant-refresh-scope-quit-blocked', async f => {
  f.hooks.refresh = () => Response.json({ access_token: 'synthetic-narrowed', expires_in: 3600, scope: 'user-read-playback-state' });
  const result = await quitThroughRegistration(f);
  assert.equal(result.prevented, 1); assert.equal(result.quits, 0); assert.equal(result.dialogs.length, 1);
  assert.equal(lastRelease(f).state, 'recoveryRequired'); assert.equal(lastRelease(f).restoreWritesStarted, false);
}));
test('no unhandled rejection escaped refresh and lifecycle races', async () => { await delay(20); assert.deepEqual(unhandled, []); });
