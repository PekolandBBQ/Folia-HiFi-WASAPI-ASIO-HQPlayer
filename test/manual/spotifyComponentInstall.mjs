import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

// Clean-directory installation of a local test artifact. This is not a distributable release bundle.
const { createSpotifyComponentManager } = createRequire(import.meta.url)('../../electron/spotify/componentManager.cjs');
const root = path.resolve('build/spotify');
const directory = await mkdtemp(path.join(tmpdir(), 'folia-spotify-install-'));
const report = { startedAt: new Date().toISOString(), version: '0.1.0' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const executable = await readFile(path.join(root, 'folia-spotify-playback.exe'));
  const metadata = { id: 'spotify', entry: 'folia-spotify-playback.exe', version: report.version, protocolMajor: 1 };
  const bytes = zipSync({ [metadata.entry]: executable, 'component.json': strToU8(JSON.stringify(metadata)),
    'NOTICE.txt': strToU8('LOCAL INSTALLATION TEST ONLY. Dependency license inventory and distribution approval are pending. Do not distribute.') });
  const localPath = path.join(root, 'installation-test.zip'), catalogPath = path.join(root, 'development-catalog.json');
  await writeFile(localPath, bytes);
  await writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [{ ...metadata, platform: 'win32-x64', localPath,
    sha256: digest(bytes), entrySha256: digest(executable) }] }));
  const manager = createSpotifyComponentManager({ app: { isPackaged: false, getPath: () => directory }, catalogPath });
  assert.equal((await manager.status()).installed, false);
  const installed = await manager.install(); assert.equal(installed.available, true); assert.equal(installed.version, report.version);
  report.installed = true; report.archiveSha256 = digest(bytes); report.executableSha256 = digest(executable);
  await writeFile(installed.executable, 'corrupted test fixture');
  assert.equal((await manager.status()).errorCode, 'COMPONENT_INTEGRITY'); report.tamperingRejected = true;
  await writeFile(installed.executable, executable);
  assert.equal((await manager.uninstall()).available, false); report.disabled = true;
  assert.equal((await manager.install()).available, true); report.reinstalled = true;
  report.success = true;
} catch (error) { report.success = false; report.error = error.message; }
finally {
  // Only the directory returned by mkdtemp is eligible for cleanup.
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('folia-spotify-install-')) throw new Error('Unsafe temporary path');
  await rm(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  const evidence = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview'); await mkdir(evidence, { recursive: true });
  const file = path.join(evidence, `component-install-${Date.now()}.json`); await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); console.log(file); process.exitCode = report.success ? 0 : 1;
}
