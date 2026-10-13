const { spotifyError } = require('./errors.cjs');

// electron/spotify/soloistBrowserSession.cjs: bounded, main-owned PCM reads for Web Audio.
// The renderer supplies only a current opaque source URL, never a guest descriptor or bearer.
function createSoloistBrowserSession({ lookup }) {
  let current, generation = 0, closed = false;
  const stale = () => spotifyError('unavailable', 'request-cancelled');
  const own = record => { if (closed || current !== record || record.controller.signal.aborted) throw stale(); };
  function get(input) {
    if (!current || current.session !== input.session) throw stale();
    return current;
  }
  async function park(record) {
    if (!record) return;
    record.controller.abort();
    const reader = record.reader; record.reader = null;
    // Abort reaches a pending guest read before the control wait. No PCM is retained after pause.
    void reader?.return?.().catch(() => {});
    await record.source.stop();
  }
  return {
    async request(input) {
      if (closed || !input || !['begin', 'position', 'start', 'pull', 'pause', 'stop'].includes(input.action)
          || !/^[a-f0-9-]{36}$/.test(input.session || '')) throw spotifyError('invalid-response', 'invalid-browser-request');
      if (input.action === 'begin') {
        if (typeof input.url !== 'string' || input.url.length > 300) throw spotifyError('invalid-response', 'invalid-browser-source');
        const source = lookup(input.url);
        if (!source || source.sampleRate !== 44100 || source.channels !== 2 || source.bitDepth !== 32
            || !Number.isSafeInteger(source.durationMs) || source.durationMs <= 0) throw spotifyError('unavailable', 'source-unavailable');
        const previous = current;
        const record = { session: input.session, source, controller: new AbortController(), generation: ++generation,
          reader: null, pulling: false, remainder: null, complete: false };
        current = record;
        try { await park(previous); } catch (error) { if (!['CANCELLED', 'STALE_SESSION'].includes(error?.code) && error?.message !== 'Spotify: request-cancelled') throw error; }
        own(record);
        return { session: record.session, generation: record.generation, durationMs: source.durationMs,
          sampleRate: 44100, channels: 2, bitDepth: 32, positionMs: 0 };
      }
      const record = get(input);
      if (input.action === 'stop') {
        if (current === record) current = null;
        await park(record); return { stopped: true };
      }
      if (input.action === 'pause') {
        const revision = ++generation; record.generation = revision;
        await park(record);
        if (current !== record || closed || record.generation !== revision) throw stale();
        record.remainder = null; record.complete = false; record.pulling = false;
        return { generation: record.generation, paused: true };
      }
      if (input.action === 'position') {
        if (!Number.isSafeInteger(input.positionMs) || input.positionMs < 0 || input.positionMs >= record.source.durationMs)
          throw spotifyError('invalid-response', 'invalid-position');
        const revision = ++generation; record.generation = revision;
        await park(record);
        if (current !== record || closed || record.generation !== revision) throw stale();
        record.controller = new AbortController(); record.remainder = null; record.complete = false; record.pulling = false;
        const positioned = await record.source.seek(input.positionMs); own(record);
        if (revision !== record.generation) throw stale();
        return { generation: revision, positionMs: positioned.positionMs };
      }
      if (input.action === 'start') {
        if (!Number.isSafeInteger(input.positionMs) || input.positionMs < 0 || input.positionMs >= record.source.durationMs)
          throw spotifyError('invalid-response', 'invalid-position');
        const revision = ++generation; record.generation = revision;
        if (record.reader || record.opening) await park(record);
        else record.controller.abort();
        if (current !== record || closed || record.generation !== revision) throw stale();
        record.controller = new AbortController(); record.remainder = null; record.complete = false; record.pulling = false;
        const controller = record.controller;
        record.opening = true;
        let opened;
        try { opened = await record.source.openReadable({ positionMs: input.positionMs, signal: controller.signal }); }
        finally { if (record.generation === revision) record.opening = false; }
        own(record);
        if (record.generation !== revision || record.controller !== controller) throw stale();
        if (typeof opened?.prepareOrigin === 'function') {
          const origin = await opened.prepareOrigin(); own(record);
          if (record.generation !== revision || record.controller !== controller) throw stale();
          if (origin?.kind !== 'confirmed-command-origin-estimate' || origin.positionMs !== opened.positionMs
            || !Number.isSafeInteger(origin.observedPositionMs) || origin.observedPositionMs < 0
            || origin.observedPositionMs >= record.source.durationMs || !Number.isSafeInteger(origin.observedAt) || origin.observedAt < 0)
            throw spotifyError('invalid-response', 'invalid-position');
        }
        if (!opened || !Number.isSafeInteger(opened.positionMs) || opened.positionMs < 0 || opened.positionMs >= record.source.durationMs)
          throw spotifyError('invalid-response', 'invalid-position');
        record.reader = opened.stream[Symbol.asyncIterator]();
        return { generation: revision, positionMs: opened.positionMs };
      }
      own(record);
      if (input.generation !== record.generation || !record.reader || record.pulling) throw stale();
      if (record.complete) return { generation: record.generation, complete: true, data: new Uint8Array(0) };
      record.pulling = true;
      const revision = record.generation, controller = record.controller;
      try {
        let bytes = record.remainder;
        if (!bytes) {
          const result = await record.reader.next(); own(record);
          if (revision !== record.generation || controller !== record.controller) throw stale();
          if (result.done) { record.complete = true; return { generation: revision, complete: true, data: new Uint8Array(0) }; }
          bytes = result.value;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 1048576 || bytes.byteLength % 8)
            throw spotifyError('invalid-response', 'invalid-pcm-block');
        }
        const length = Math.min(bytes.byteLength, 65536);
        // IPC gets a private bounded copy; a producer may reuse its input backing buffer.
        const data = Uint8Array.from(bytes.subarray(0, length));
        record.remainder = length < bytes.byteLength ? Uint8Array.from(bytes.subarray(length)) : null;
        return { generation: revision, complete: false, data };
      } finally { if (revision === record.generation && controller === record.controller) record.pulling = false; }
    },
    // Account/service cleanup must still finish when a revoked source or external track rejects pause.
    // park already aborts the reader first; owner-gated stop never mutates a different user's track.
    async clear() { const previous = current; current = null; await park(previous).catch(() => {}); },
    async close() { closed = true; const previous = current; current = null; await park(previous).catch(() => {}); },
  };
}
module.exports = { createSoloistBrowserSession };
