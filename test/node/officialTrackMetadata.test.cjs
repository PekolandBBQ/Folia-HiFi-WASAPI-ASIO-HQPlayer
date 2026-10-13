'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOfficialTrackMetadata } = require('../../electron/spotify/officialTrackMetadata.cjs');
const { createSessionVault } = require('../../electron/spotify/sessionVault.cjs');
const ID = 'A'.repeat(22), OTHER = 'B'.repeat(22);
const full = (id = ID) => ({ type: 'track', id, uri: `spotify:track:${id}`, is_local: false,
  is_playable: true, duration_ms: 180000, album: { id: 'C'.repeat(22) } });
function metadata() {
  let at = 100000, stamp = { epoch: 1, revision: 1 };
  const store = createOfficialTrackMetadata({ now: () => at, getStamp: () => stamp });
  return { store, advance: value => { at += value; }, change: value => { stamp = value; } };
}
test('only complete official facts enter cache; no title/artist retained', () => {
  const { store } = metadata(), r = store.bind();
  const entry = store.remember({ ...full(), name: 'not retained', artists: [{ name: 'private sentinel' }] }, ID, r);
  assert.deepEqual(entry.facts, { trackId: ID, durationMs: 180000 });
  assert.equal(JSON.stringify(entry).includes('sentinel'), false);
  for (const override of [{ is_playable: false }, { is_playable: undefined }, { is_local: true },
    { album: undefined }, { restrictions: { reason: 'market' } }, { duration_ms: 0 }]) {
    store.remember(full(), ID, r); assert.equal(store.remember({ ...full(), ...override }, ID, r), null);
    assert.equal(store.get(ID, r), null);
  }
});
test('strict original sixty-second age, rollback invalidation and no stale account refill', () => {
  const { store, advance, change } = metadata(), receipt = store.bind();
  store.remember(full(), ID, receipt); advance(59999); assert.ok(store.get(ID, receipt));
  advance(1); assert.equal(store.get(ID, receipt), null);
  store.remember(full(), ID, receipt); advance(-1); assert.equal(store.get(ID, receipt), null);
  change({ epoch: 2, revision: 0 }); const next = store.bind();
  assert.equal(store.remember(full(), ID, receipt), null); assert.equal(store.get(ID, next), null);
});
test('market/account profile changes revoke in-flight receipt, unrelated equal profile preserves it', () => {
  const { store } = metadata(); store.profile({ id: 'same-account', country: 'US' });
  const r = store.bind(); store.remember(full(), ID, r);
  store.profile({ id: 'same-account', country: 'US' }); assert.ok(store.get(ID, r));
  store.profile({ id: 'same-account', country: 'GB' }); assert.equal(store.get(ID, r), null);
  assert.equal(store.remember(full(), ID, r), null);
});
test('relink validation, one hundred twenty-eight bound and conditional eviction', () => {
  const { store } = metadata(), r = store.bind();
  assert.equal(store.remember(full(OTHER), ID, r), null);
  const e = store.remember({ ...full(OTHER), linked_from: { id: ID, uri: `spotify:track:${ID}`, type: 'track' } }, ID, r);
  assert.equal(e.facts.trackId, OTHER);
  const newer = store.remember(full(), ID, r); store.remove(ID, e); assert.equal(store.get(ID, r), newer);
  for (let i = 0; i < 129; i++) { const id = String(i).padStart(22, '0'); store.remember(full(id), id, r); }
  assert.equal(store.get(ID, r), null); assert.equal(store.get('0'.repeat(22), r), null);
});
test('response observations bounded at fifty and unrelated album does not revoke track cache', () => {
  const { store } = metadata(), r = store.bind(); store.remember(full(), ID, r);
  store.observeResponse({ type: 'album', id: ID }, r); assert.ok(store.get(ID, r));
  store.observeResponse({ items: [{ type: 'album', id: ID }] }, r); assert.ok(store.get(ID, r));
  store.observeResponse({ items: Array.from({ length: 51 }, (_, i) => ({ track: full(String(i).padStart(22, '0')) })) }, r);
  assert.ok(store.get('49'.padStart(22, '0'), r)); assert.equal(store.get('50'.padStart(22, '0'), r), null);
  store.clear(); assert.equal(store.get(ID, r), null);
});
async function vaultHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-r34-facts-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reads = 0, at = 100000, fetches = 0;
  const vault = createSessionVault({ directory, now: () => at, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
    decryptString: value => { reads++; return value.toString(); },
  }, fetcher: async () => { fetches++; return { ok: true, json: async () => ({ access_token: 'refreshed-fixture', expires_in: 3600 }) }; } });
  const grant = token => ({ access_token: token, refresh_token: 'refresh-fixture', clientId: 'client-fixture', expiresAt: at + 3600000, scope: 'user-read-private user-read-playback-state' });
  return { vault, grant, reads: () => reads, fetches: () => fetches, advance: value => { at += value; } };
}
test('five-second vault snapshot coalesces local token/scope decrypt without persisting new fields', async t => {
  const h = await vaultHarness(t); await h.vault.save(h.grant('token-fixture'));
  assert.equal(await h.vault.token(), 'token-fixture'); assert.equal(h.reads(), 1);
  await h.vault.grantedScopes(); await h.vault.token(); assert.equal(h.reads(), 1);
  h.advance(5000); await h.vault.token(); assert.equal(h.reads(), 2);
  h.advance(-1); await h.vault.grantedScopes(); assert.equal(h.reads(), 3); assert.equal(h.fetches(), 0);
});
test('queued grant save cannot be bypassed by hot token/scope cache', async t => {
  const h = await vaultHarness(t); await h.vault.save(h.grant('old-fixture')); await h.vault.token();
  const saving = h.vault.save(h.grant('new-fixture'));
  const response = h.vault.token(); await saving;
  await assert.rejects(response, error => error.code === 'auth-required');
  assert.equal(await h.vault.token(), 'new-fixture');
});
test('refresh reads refresh token only on expiry and clears old snapshot on grant commit', async t => {
  const h = await vaultHarness(t); await h.vault.save({ ...h.grant('expired-fixture'), expiresAt: 100001 });
  assert.equal(await h.vault.token(), 'refreshed-fixture'); assert.equal(h.fetches(), 1);
  assert.equal(await h.vault.token(), 'refreshed-fixture'); assert.equal(h.fetches(), 1);
});
test('logout/dispose invalidate hot snapshot, never returning cached token afterward', async t => {
  const h = await vaultHarness(t); await h.vault.save(h.grant('fixture')); await h.vault.token();
  h.vault.dispose(); await h.vault.token(); assert.equal(h.reads(), 2);
  await h.vault.clear(); assert.equal(await h.vault.token(), null); assert.equal((await h.vault.grantedScopes()).scopes, null);
});
