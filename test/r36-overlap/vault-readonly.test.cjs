'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
// Actual vault persistence/refresh behavior with generated fake credentials only.
async function fixture(task) {
  const directory = await fs.mkdtemp(path.join(__dirname, 'fake-vault-'));
  let now = 1000, refreshes = 0, reply;
  const vault = createSessionVault({ directory, now: () => now,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    fetcher: async (_url, init) => { refreshes++; assert.equal(init.method, 'POST');
      if (reply) await reply;
      return Response.json({ access_token: 'fake-refreshed', expires_in: 3600 }); },
  });
  await vault.save({ access_token: 'fake-initial', refresh_token: 'fake-refresh', clientId: 'fake-client',
    expiresAt: 61001, scope: 'user-read-playback-state user-modify-playback-state' });
  try { await task({ vault, directory, refreshes: () => refreshes, advance: value => { now += value; }, block: value => { reply = value; } }); }
  finally { vault.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}
test('read-only token strictly refuses the 60-second refresh threshold without writes or a POST', () => fixture(async f => {
  const initial = await fs.readFile(path.join(f.directory, 'session.enc'));
  assert.equal(await f.vault.token({ allowRefresh: false }), 'fake-initial');
  f.advance(1); const stamp = f.vault.stamp();
  assert.deepEqual(await Promise.all([f.vault.token({ allowRefresh: false }), f.vault.token({ allowRefresh: false })]), [null, null]);
  assert.equal(f.refreshes(), 0); assert.deepEqual(f.vault.stamp(), stamp);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'session.enc')), initial);
}));
test('read-only token does not join or initiate an in-flight refresh', () => fixture(async f => {
  f.advance(2); let finish; f.block(new Promise(resolve => { finish = resolve; }));
  const stamp = f.vault.stamp(), refreshing = f.vault.token();
  const readonly = await f.vault.token({ allowRefresh: false }); assert.equal(readonly, null);
  assert.deepEqual(f.vault.stamp(), stamp); finish(); assert.equal(await refreshing, 'fake-refreshed');
  assert.equal(f.refreshes(), 1); assert.deepEqual(f.vault.stamp(), stamp);
  assert.equal(await f.vault.token({ allowRefresh: false }), 'fake-refreshed'); assert.equal(f.refreshes(), 1);
}));
test('normal concurrent refresh remains coalesced while speculative calls only defer', () => fixture(async f => {
  f.advance(2); const stamp = f.vault.stamp();
  const result = await Promise.all([f.vault.token(), f.vault.token(), f.vault.token({ allowRefresh: false }), f.vault.token()]);
  assert.deepEqual(result, ['fake-refreshed', 'fake-refreshed', null, 'fake-refreshed']);
  assert.equal(f.refreshes(), 1); assert.deepEqual(f.vault.stamp(), stamp);
}));
test('logout clears read-only access and cannot resurrect the previous token snapshot', () => fixture(async f => {
  assert.equal(await f.vault.token({ allowRefresh: false }), 'fake-initial');
  await f.vault.clear(); assert.equal(await f.vault.token({ allowRefresh: false }), null); assert.equal(f.refreshes(), 0);
}));

test('ordinary unexpired token reads remain parallel and do not masquerade as a refresh', () => fixture(async f => {
  assert.deepEqual(await Promise.all([f.vault.token(), f.vault.token({ allowRefresh: false }), f.vault.token({ allowRefresh: false })]),
    ['fake-initial', 'fake-initial', 'fake-initial']);
  assert.equal(f.refreshes(), 0);
}));

test('unknown stored expiry cannot authorize a speculative token', () => fixture(async f => {
  const file = path.join(f.directory, 'session.enc');
  const stored = JSON.parse((await fs.readFile(file)).toString()); delete stored.expiresAt;
  await fs.writeFile(file, JSON.stringify(stored)); f.vault.dispose();
  assert.equal(await f.vault.token({ allowRefresh: false }), null); assert.equal(f.refreshes(), 0);
}));
