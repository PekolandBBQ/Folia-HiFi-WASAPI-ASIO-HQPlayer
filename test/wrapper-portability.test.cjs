'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { wrapperPaths } = require('../electron/spotify/wrapperPaths.cjs');
const { createBridge } = require('../electron/spotify/wrapper/bridge.cjs');
// These tests exercise path relocation and a real local WebSocket without Spotify.
test('fresh profile has no implicit developer asset path; relocated profile resolves its own assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-portable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'first');
  const runtime = wrapperPaths({ resourcesPath: path.join(root, 'resources'), profile, environment: {} });
  assert.equal(runtime.readApps(), path.join(profile, 'spotify/unconfigured-apps'));
  runtime.saveApps(path.join(profile, 'spotify/configured/v1/spotify/Apps'));
  await fs.rename(profile, path.join(root, 'moved'));
  const moved = wrapperPaths({ resourcesPath: path.join(root, 'resources'), profile: path.join(root, 'moved'), environment: {} });
  assert.equal(moved.readApps(), path.join(root, 'moved/spotify/configured/v1/spotify/Apps'));
  assert.equal(path.dirname(moved.route), path.dirname(path.dirname(moved.capture)));
});
test('packaged bridge resolves app dependency and transports a real message using a new profile secret', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-bridge-'));
  const bridge = createBridge(() => {}, { secretPath: path.join(root, 'local-bridge.key'), port: 0 });
  t.after(async () => { bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  const { url } = await bridge.start();
  const WebSocket = require('ws');
  const client = new WebSocket(url, { origin: 'https://xpui.app.spotify.com' });
  t.after(() => client.terminate());
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  client.on('message', bytes => { const input = JSON.parse(bytes); client.send(JSON.stringify({ id: input.id, ok: true, value: { operation: input.op } })); });
  assert.deepEqual(await bridge.request('snapshot'), { operation: 'snapshot' });
});
