const { zipSync, unzipSync } = require('fflate');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { patchWavWorker } = require('./buildWavListeningComponent.cjs');

// packaging/exclusive/buildWavReleaseComponent.cjs — one integrity-covered worker for the verified WAV input.
async function buildWavReleaseComponent(archive, version = '0.1.4-preview.8') {
    const files = unzipSync(archive), old = JSON.parse(Buffer.from(files['component.json']).toString());
    if (old.id !== 'hqplayer' || old.version !== '0.1.4-preview.7') throw Error('Expected the verified preview.7 baseline');
    let source = patchWavWorker(Buffer.from(files['hqplayer-component.cjs']).toString());
    const marker = '"version": "0.1.4-preview.7"';
    if (source.split(marker).length !== 2) throw Error('Unexpected worker version declaration');
    source = source.replace(marker, '"version": ' + JSON.stringify(version));
    // Embed helpers so normal entry verification covers framing, address and cache code.
    const entry = path.resolve(__dirname, '../../electron/hqplayer/folia-release-worker.cjs');
    const { rolldown } = await import('rolldown');
    const bundled = await rolldown({ input: entry, platform: 'node', external: [/^node:/],
        plugins: [{ name: 'verified-wav-worker', resolveId: id => id === entry ? entry : null,
            load: id => id === entry ? source : null }] });
    let worker;
    try { worker = Buffer.from((await bundled.generate({ format: 'cjs' })).output[0].code); }
    finally { await bundled.close(); }
    files['hqplayer-component.cjs'] = worker;
    files['component.json'] = Buffer.from(JSON.stringify({ ...old, version }));
    const bytes = Buffer.from(zipSync(files, { level: 9, mtime: new Date('2026-10-21T00:00:00Z') }));
    const hash = value => createHash('sha256').update(value).digest('hex');
    return { bytes, files, release: { version, protocolMajor: 1, platform: 'win32-x64',
        sha256: hash(bytes), entrySha256: hash(worker) } };
}
module.exports = { buildWavReleaseComponent };
