'use strict';
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { TextDecoder } = require('node:util');

// Downloaded separately on the user's machine. Spotify prohibits bundling or
// redistributing this archive; these digests attest our own official download.
const OFFICIAL_URL = 'https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz';
const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_EXPANDED = 128 * 1024 * 1024;
const failure = code => Object.assign(new Error(`Spotify: ${code}`), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function textField(bytes) {
  const zero = bytes.indexOf(0);
  if (zero >= 0 && bytes.subarray(zero).some(value => value !== 0)) throw failure('soloist-archive-invalid');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(zero < 0 ? bytes : bytes.subarray(0, zero)); }
  catch { throw failure('soloist-archive-invalid'); }
}
function octal(bytes) {
  const value = bytes.toString('ascii').replace(/^[\0 ]+|[\0 ]+$/g, '');
  if (!/^[0-7]+$/.test(value)) throw failure('soloist-archive-invalid');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_EXPANDED) throw failure('soloist-archive-invalid');
  return result;
}
function extractOfficialExecutable(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length < 18 || archiveBytes.length > MAX_ARCHIVE
      || archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) throw failure('soloist-archive-invalid');
  let tar;
  try { tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_EXPANDED }); }
  catch { throw failure('soloist-archive-invalid'); }
  let cursor = 0, count = 0, executable, ended = false;
  try {
    while (cursor + 512 <= tar.length) {
      const header = tar.subarray(cursor, cursor + 512);
      if (header.every(value => value === 0)) {
        if (tar.length - cursor < 1024 || tar.subarray(cursor).some(value => value !== 0)) throw failure('soloist-archive-invalid');
        ended = true; break;
      }
      if (++count > 128) throw failure('soloist-archive-invalid');
      const expectedChecksum = octal(header.subarray(148, 156));
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
      if (checksum !== expectedChecksum) throw failure('soloist-archive-invalid');
      const name = textField(header.subarray(0, 100)), prefix = textField(header.subarray(345, 500));
      const fullName = prefix ? `${prefix}/${name}` : name;
      if (!fullName || fullName.startsWith('/') || /[\\\r\n\0]/.test(fullName)
          || fullName.split('/').some(part => part === '..' || part === '.')) throw failure('soloist-archive-invalid');
      const size = octal(header.subarray(124, 136)), type = header[156];
      if (![0, 48, 53].includes(type) || (type === 53 && size !== 0)) throw failure('soloist-archive-invalid');
      cursor += 512;
      const padded = Math.ceil(size / 512) * 512;
      if (cursor + padded > tar.length) throw failure('soloist-archive-invalid');
      if (fullName.split('/').at(-1) === 'soloist') {
        if (executable || ![0, 48].includes(type) || size < 64) throw failure('soloist-archive-invalid');
        executable = Buffer.from(tar.subarray(cursor, cursor + size));
      }
      cursor += padded;
    }
    if (!ended || !executable || executable.subarray(0, 4).toString('hex') !== '7f454c46'
        || executable[4] !== 2 || executable[5] !== 1 || executable[6] !== 1
        || ![2, 3].includes(executable.readUInt16LE(16)) || executable.readUInt16LE(18) !== 62)
      throw failure('soloist-archive-invalid');
    return executable;
  } catch (error) { executable?.fill(0); throw error; }
  finally { tar.fill(0); }
}
async function downloadSoloistOfficialAsset({ fetchImpl = globalThis.fetch, signal, onProgress, now = Date.now } = {}) {
  if (process.type === 'renderer') throw failure('soloist-main-required');
  if (typeof fetchImpl !== 'function' || (onProgress != null && typeof onProgress !== 'function')) throw failure('soloist-download-invalid');
  if (signal?.aborted) throw failure('request-cancelled');
  const timed = AbortSignal.timeout(120000), combined = AbortSignal.any([timed, ...(signal ? [signal] : [])]);
  const blocks = []; let reader, archiveBytes, executable, length = 0;
  try {
    const response = await fetchImpl(OFFICIAL_URL, { redirect: 'error', cache: 'no-store', signal: combined,
      headers: { Accept: 'application/gzip, application/x-tar, application/octet-stream' } });
    if (response.status !== 200 || !response.body || (response.url && response.url !== OFFICIAL_URL)) throw failure('soloist-download-failed');
    const declared = response.headers.get('content-length');
    const total = declared == null ? null : /^\d+$/.test(declared) ? Number(declared) : NaN;
    if (total != null && (!Number.isSafeInteger(total) || total < 18 || total > MAX_ARCHIVE)) throw failure('soloist-download-invalid');
    reader = response.body.getReader();
    onProgress?.({ stage: 'download', loaded: 0, total });
    for (;;) {
      if (combined.aborted) throw failure(signal?.aborted ? 'request-cancelled' : 'soloist-download-timeout');
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_ARCHIVE || length + value.byteLength > MAX_ARCHIVE) throw failure('soloist-download-invalid');
      length += value.byteLength; blocks.push(Buffer.from(value));
      onProgress?.({ stage: 'download', loaded: length, total });
    }
    if (total != null && length !== total) throw failure('soloist-download-invalid');
    if (combined.aborted) throw failure(signal?.aborted ? 'request-cancelled' : 'soloist-download-timeout');
    archiveBytes = Buffer.concat(blocks, length); executable = extractOfficialExecutable(archiveBytes);
    const etag = response.headers.get('etag');
    return Object.freeze({ archiveBytes, archiveSha256: digest(archiveBytes), executableSha256: digest(executable),
      downloadedAt: now(), etag: etag && etag.length <= 256 && /^[\x20-\x7e]+$/.test(etag) ? etag : null,
      source: 'spotify-official-cdn', architecture: 'x86_64' });
  } catch (error) {
    archiveBytes?.fill(0);
    if (signal?.aborted) throw failure('request-cancelled');
    if (timed.aborted) throw failure('soloist-download-timeout');
    if (/^(?:soloist-[a-z-]+|request-cancelled)$/.test(error?.code || '')) throw error;
    throw failure('soloist-download-failed');
  } finally {
    for (const block of blocks) block.fill(0); executable?.fill(0);
    try { await reader?.cancel(); } catch { /* The bounded reader may already be closed. */ }
    reader?.releaseLock();
  }
}
module.exports = { downloadSoloistOfficialAsset, extractOfficialExecutable, OFFICIAL_URL };
