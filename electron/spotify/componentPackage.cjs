'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { unzipSync } = require('fflate');
// Pinned third-party packages use the project's existing fflate dependency.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(Error(code), { code });
async function acquirePackage(pin, directory, { fetcher = fetch, progress = () => {} } = {}) {
  const destination = path.join(directory, pin.version + '-' + pin.sha256.slice(0, 12));
  try {
    const marker = JSON.parse(await fs.readFile(path.join(destination, 'folia-package.json'), 'utf8'));
    const entry = await fs.readFile(path.join(destination, pin.entry));
    if (marker.archiveSha256 === pin.sha256 && digest(entry) === marker.entrySha256
      && (!pin.entrySha256 || digest(entry) === pin.entrySha256)) return destination;
    throw fail('SPOTIFY_COMPONENT_INTEGRITY');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  progress('download');
  const response = await fetcher(pin.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw fail('SPOTIFY_COMPONENT_DOWNLOAD_FAILED');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 64 * 1024 * 1024) throw fail('SPOTIFY_COMPONENT_ARCHIVE_INVALID');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== pin.sha256) throw fail('SPOTIFY_COMPONENT_INTEGRITY');
  let expanded = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.includes(':')
      || entry.name.split('/').includes('..')) throw fail('SPOTIFY_COMPONENT_ARCHIVE_INVALID');
    expanded += entry.originalSize;
    if (expanded > 200 * 1024 * 1024) throw fail('SPOTIFY_COMPONENT_ARCHIVE_INVALID');
    return !entry.name.endsWith('/');
  } });
  if (!files[pin.entry] || (pin.entrySha256 && digest(files[pin.entry]) !== pin.entrySha256)) throw fail('SPOTIFY_COMPONENT_INTEGRITY');
  await fs.mkdir(directory, { recursive: true });
  const staging = path.join(directory, '.prepare-' + randomUUID());
  await fs.mkdir(staging);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(staging, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx' });
  }
  await fs.writeFile(path.join(staging, 'folia-package.json'), JSON.stringify({ archiveSha256: pin.sha256, entrySha256: digest(files[pin.entry]) }));
  // Never replace an existing package or an executable loaded by another process.
  await fs.rename(staging, destination);
  return destination;
}
module.exports = { acquirePackage, digest, fail };
