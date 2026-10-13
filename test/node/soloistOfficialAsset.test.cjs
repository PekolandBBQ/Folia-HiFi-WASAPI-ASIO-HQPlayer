const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { downloadSoloistOfficialAsset, extractOfficialExecutable, OFFICIAL_URL } = require('../../electron/spotify/soloistOfficialAsset.cjs');

const elf = () => { const bytes = Buffer.alloc(96); bytes.write('ELF', 1); bytes[0] = 0x7f; bytes[4] = 2; bytes[5] = bytes[6] = 1; bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); return bytes; };
function tar(entries = [{ name: 'release/soloist', data: elf() }]) {
  const blocks = [];
  for (const { name, data = Buffer.alloc(0), type = '0' } of entries) {
    const header = Buffer.alloc(512); header.write(name); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const archive = entries => gzipSync(tar(entries));
const hash = value => createHash('sha256').update(value).digest('hex');
const rejects = (task, code) => assert.rejects(task, error => error.code === code && !error.message.includes('sensitive-fixture'));

test('official archive supplies a main-derived x86_64 binary digest; no archive is written', async () => {
  const bytes = archive(), progress = [], requests = [];
  const result = await downloadSoloistOfficialAsset({ now: () => 12345, onProgress: item => progress.push(item), fetchImpl: async (...args) => {
    requests.push(args); return new Response(bytes, { headers: { 'content-length': String(bytes.length), etag: '"public-etag"' } });
  } });
  assert.equal(requests[0][0], OFFICIAL_URL); assert.equal(requests[0][1].redirect, 'error');
  assert.equal(requests[0][1].headers.Authorization, undefined);
  assert.equal(result.archiveSha256, hash(bytes)); assert.equal(result.executableSha256, hash(elf()));
  assert.equal(result.source, 'spotify-official-cdn'); assert.equal(result.downloadedAt, 12345);
  assert.equal(progress.at(-1).loaded, bytes.length); assert.equal(result.etag, '"public-etag"');
  result.archiveBytes.fill(0);
});
test('source archive permits documentation and directories without extracting them', () => {
  const bytes = archive([{ name: 'release/', type: '5' }, { name: 'release/THIRD_PARTY_LICENSES.txt', data: Buffer.from('notice') }, { name: 'release/soloist', data: elf() }]);
  assert.deepEqual(extractOfficialExecutable(bytes), elf());
});
for (const name of ['../soloist', '/soloist', 'release/../soloist', 'C:\\soloist']) test(`unsafe archive path is rejected: ${name}`, () => {
  assert.throws(() => extractOfficialExecutable(archive([{ name, data: elf() }])), { code: 'soloist-archive-invalid' });
});
test('links, duplicate executables and non-x86_64 executables are rejected', () => {
  for (const type of ['1', '2', '3', '6', 'x']) assert.throws(() => extractOfficialExecutable(archive([{ name: 'soloist', data: elf(), type }])), { code: 'soloist-archive-invalid' });
  assert.throws(() => extractOfficialExecutable(archive([{ name: 'a/soloist', data: elf() }, { name: 'b/soloist', data: elf() }])), { code: 'soloist-archive-invalid' });
  const arm = elf(); arm.writeUInt16LE(183, 18);
  assert.throws(() => extractOfficialExecutable(archive([{ name: 'soloist', data: arm }])), { code: 'soloist-archive-invalid' });
});
test('corrupt headers, truncation and hidden data after the terminator are rejected', () => {
  const corrupt = tar(); corrupt[101]++;
  for (const bytes of [gzipSync(corrupt), gzipSync(tar().subarray(0, 1024)), gzipSync(Buffer.concat([tar(), Buffer.from('extra-data')])), Buffer.from('sensitive-fixture')]) {
    assert.throws(() => extractOfficialExecutable(bytes), { code: 'soloist-archive-invalid' });
  }
});
test('HTTP errors and untrusted final URL produce bounded public errors', async () => {
  await rejects(downloadSoloistOfficialAsset({ fetchImpl: async () => new Response('sensitive-fixture', { status: 302 }) }), 'soloist-download-failed');
  await rejects(downloadSoloistOfficialAsset({ fetchImpl: async () => { const response = new Response(archive()); Object.defineProperty(response, 'url', { value: 'https://untrusted.invalid/soloist' }); return response; } }), 'soloist-download-failed');
  await rejects(downloadSoloistOfficialAsset({ fetchImpl: async () => { throw Error('sensitive-fixture'); } }), 'soloist-download-failed');
});
test('declared length cannot evade the stream limit or accept a truncated download', async () => {
  for (const length of ['67108865', '15', 'bad', String(archive().length + 1)]) await rejects(downloadSoloistOfficialAsset({ fetchImpl: async () => new Response(archive(), { headers: { 'content-length': length } }) }), 'soloist-download-invalid');
});
test('cancellation before fetch and during progress never publishes an asset', async () => {
  const first = new AbortController(); first.abort(); let calls = 0;
  await rejects(downloadSoloistOfficialAsset({ signal: first.signal, fetchImpl: () => { calls++; } }), 'request-cancelled'); assert.equal(calls, 0);
  const controller = new AbortController();
  await rejects(downloadSoloistOfficialAsset({ signal: controller.signal, fetchImpl: async () => new Response(archive()), onProgress: progress => { if (progress.loaded) controller.abort(); } }), 'request-cancelled');
});
test('excessively expanded gzip cannot allocate an unbounded tar', () => {
  const compressed = gzipSync(Buffer.alloc(129 * 1024 * 1024));
  assert.throws(() => extractOfficialExecutable(compressed), { code: 'soloist-archive-invalid' });
});
