'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const asar = require('@electron/asar');
const { syncDesktopScripts, scripts } = require('../../packaging/exclusive/syncDesktopScripts.cjs');

// Exercise the reused-package boundary that source-only discovery tests cannot cover.
test('refreshes all physical scripts from the final app archive, retaining unrelated resources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-packaged-scripts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'), resources = path.join(root, 'resources');
  await fs.mkdir(path.join(input, 'electron/spotify'), { recursive: true });
  await fs.mkdir(path.join(resources, 'spotify-wrapper/scripts'), { recursive: true });
  for (const name of scripts) {
    await fs.copyFile(path.join(__dirname, '../../electron/spotify', name), path.join(input, 'electron/spotify', name));
    await fs.writeFile(path.join(resources, 'spotify-wrapper/scripts', name), 'old package');
  }
  await fs.writeFile(path.join(resources, 'retain.txt'), 'unchanged');
  await asar.createPackage(input, path.join(resources, 'app.asar'));
  await syncDesktopScripts(resources);
  const discovery = await fs.readFile(path.join(resources, 'spotify-wrapper/scripts/desktopDiscovery.ps1'), 'utf8');
  assert.match(discovery, /binaryVersion/);
  assert.match(discovery, /commandLineKnown/);
  for (const name of scripts) assert.equal(await fs.readFile(path.join(resources, 'spotify-wrapper/scripts', name), 'utf8'), await fs.readFile(path.join(input, 'electron/spotify', name), 'utf8'));
  assert.equal(await fs.readFile(path.join(resources, 'retain.txt'), 'utf8'), 'unchanged');
});
