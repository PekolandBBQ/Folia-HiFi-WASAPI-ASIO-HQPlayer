const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMediaServer } = require('./mediaServer.cjs');
const { spotifyError } = require('./errors.cjs');
const { createTemporaryAudioDirectory, closeTemporaryAudioDirectory } = require('./temporaryAudio.cjs');

// An account-session cache only: no durable audio library, renderer file paths, or exported credentials.
function createAudioPreparation({ directory, native, vault, media = createMediaServer() }) {
  const cache = new Map(), jobs = new Map(), garbage = new Set(), pending = new Set();
  let generation = 0, folder;
  const cancelled = () => spotifyError('unavailable', 'request-cancelled');
  function checkRequest(id, requestId, quality) {
    if (!['standard', 'high'].includes(quality)) throw spotifyError('unsupported', 'quality-unsupported');
    if (!/^[A-Za-z0-9]{22}$/.test(id) || !/^[a-f0-9-]{36}$/.test(requestId)) throw spotifyError('invalid-response', 'invalid-audio-request');
    if (jobs.has(requestId) || (jobs.size >= 4 && !cache.has(`${id}:${quality}`))) throw spotifyError('unavailable', 'preparation-busy');
  }
  function stillCurrent(expected, controller) { if (expected !== generation || controller.signal.aborted) throw cancelled(); }
  function awaitActive(task, signal) {
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve(task).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function trimCache(protectedKey) {
    while (cache.size > 3) {
      const removable = [...cache].find(([key, entry]) => key !== protectedKey && (!entry.completion || entry.complete) && !entry.handle?.activeReaders?.());
      if (!removable) break;
      const [key, entry] = removable; cache.delete(key); entry.handle?.revoke(); if (entry.file) await remove(entry.file);
    }
  }
  async function remove(file) {
    // Windows may retain the helper's file handle briefly after cancellation.
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await fs.rm(file, { force: true }); garbage.delete(file); return; }
      catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 11) { garbage.add(file); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  async function run(id, requestId, onProgress = () => {}, quality = 'high') {
    checkRequest(id, requestId, quality);
    const cacheKey = `${id}:${quality}`;
    const expected = generation;
    const controller = new AbortController(); jobs.set(requestId, controller);
    let file, handle;
    try {
      if (!await vault.token()) throw spotifyError('auth-required');
      if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
      const cached = cache.get(cacheKey);
      if (cached) {
        await awaitActive(cached.completion, controller.signal); await cached.handle?.completed;
        stillCurrent(expected, controller);
        cache.delete(cacheKey); cache.set(cacheKey, cached); onProgress({ stage: 'cache', loaded: 1, total: 1, unit: 'items' }); return cached.source;
      }
      if (jobs.size > 4) throw spotifyError('unavailable', 'preparation-busy');
      if (!folder) folder = createTemporaryAudioDirectory(directory);
      file = path.join(await folder, `${randomUUID()}.wav`);
      if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
      let durationMs;
      const ready = await native.request({ action: 'audio', trackId: id, output: file, quality }, { signal: controller.signal, onProgress: event => {
        if (event.event === 'metadata') durationMs = event.durationMs;
        if (event.event === 'connecting') onProgress({ stage: 'connect' });
        if (event.event === 'loading') onProgress({ stage: 'download' });
        if (event.event === 'decoding') onProgress({ stage: 'decode', loaded: event.positionMs, total: durationMs, unit: 'milliseconds' });
      } });
      if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
      onProgress({ stage: 'validate' });
      const stat = await fs.stat(file);
      if (!Number.isSafeInteger(ready.samples) || ready.samples <= 0 || stat.size !== 44 + ready.samples * 4) throw spotifyError('invalid-response', 'invalid-audio');
      const facts = sourceFacts(ready, false);
      await verifyPrefix(file, facts);
      handle = await media.add(file);
      if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
      // A decoded PCM file proves its prepared format, not the original lossy encoding or tier.
      const source = { url: handle.url, fetchedAt: Date.now(), quality: null, actualQuality: null,
        requestedQuality: quality, sourceInfo: facts,
        preparedAudio: { representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 } };
      // Keep a small working set for output changes and back/forward navigation.
      // Concurrent consumers can finish the same song together. Reuse the first published handle.
      const existing = cache.get(cacheKey);
      if (existing) {
        handle.revoke(); await remove(file);
        await awaitActive(existing.completion, controller.signal); await existing.handle?.completed;
        if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
        return existing.source;
      }
      cache.set(cacheKey, { source, file, handle });
      await trimCache(cacheKey);
      if (expected !== generation || controller.signal.aborted) throw spotifyError('unavailable', 'request-cancelled');
      return source;
    } catch (error) { handle?.revoke(); if (file) await remove(file); throw error; }
    finally { if (jobs.get(requestId) === controller) jobs.delete(requestId); }
  }
  function sourceFacts(event, encoded = true) {
    if (!encoded) {
      if (event?.representation !== 'float32' || event.sampleRate !== 44100 || event.channels !== 2 ||
        !Number.isSafeInteger(event.samples) || event.samples <= 0 || event.samples % 2 !== 0 || event.samples > 44100 * 2 * 3600)
        throw spotifyError('invalid-response', 'invalid-stream-audio');
      return { codec: null, container: null, encodingVerified: false, sampleRate: null, channels: null,
        bitDepth: null, bitrate: null, bitrateKind: null, lossless: null };
    }
    const info = event?.source;
    if (event?.representation !== 'ogg-vorbis' || !Number.isSafeInteger(event.bytes) || event.bytes <= 0 || !Number.isSafeInteger(event.pcmFrames) || event.pcmFrames < 0 ||
      info?.sourceEncoding !== 'vorbis' || info.sourceContainer !== 'ogg' || info.sourceEncodingVerified !== true || info.sourceLossless !== false ||
      !Number.isSafeInteger(info.sourceSampleRate) || info.sourceSampleRate < 8000 || info.sourceSampleRate > 384000 ||
      !Number.isSafeInteger(info.sourceChannels) || info.sourceChannels < 1 || info.sourceChannels > 8 ||
      (info.sourceBitrate !== null && (!Number.isSafeInteger(info.sourceBitrate) || info.sourceBitrate <= 0 || info.sourceBitrate > 2000000)))
      throw spotifyError('invalid-response', 'invalid-stream-audio');
    // Rebuild an allowlist rather than letting arbitrary native fields cross the renderer boundary.
    return { codec: 'vorbis', container: 'ogg', encodingVerified: true, sampleRate: info.sourceSampleRate,
      channels: info.sourceChannels, bitDepth: null, bitrate: info.sourceBitrate,
      bitrateKind: 'vorbis-identification-nominal', lossless: false };
  }
  async function verifyPrefix(file, facts) {
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(58); const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!facts.encodingVerified) {
        if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' ||
          header.readUInt16LE(20) !== 3 || header.readUInt16LE(22) !== 2 || header.readUInt32LE(24) !== 44100 || header.readUInt16LE(34) !== 32)
          throw spotifyError('invalid-response', 'invalid-stream-audio');
        return;
      }
      const nominal = header.readInt32LE(48);
      if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'OggS' || header[4] !== 0 || !(header[5] & 2) ||
        header[26] !== 1 || header[27] !== 30 || !header.subarray(28, 35).equals(Buffer.from('\x01vorbis')) ||
        header[39] !== facts.channels || header.readUInt32LE(40) !== facts.sampleRate || (nominal > 0 ? nominal : null) !== facts.bitrate)
        throw spotifyError('invalid-response', 'invalid-stream-audio');
    } finally { await handle.close(); }
  }
  async function runStreaming(id, requestId, onProgress = () => {}, quality = 'high') {
    checkRequest(id, requestId, quality);
    const expected = generation, cacheKey = `${id}:${quality}`, controller = new AbortController();
    jobs.set(requestId, controller);
    let releaseToProducer = false;
    try {
      if (!await vault.token()) throw spotifyError('auth-required');
      stillCurrent(expected, controller);
      const cached = cache.get(cacheKey);
      if (cached) {
        const source = await awaitActive(cached.sourceReady || cached.source, controller.signal);
        stillCurrent(expected, controller); cache.delete(cacheKey); cache.set(cacheKey, cached); return source;
      }
      if (jobs.size > 4) throw spotifyError('unavailable', 'preparation-busy');
      let resolveEarly, rejectEarly, completeProducer, failProducer;
      const early = new Promise((resolve, reject) => { resolveEarly = resolve; rejectEarly = reject; });
      const completion = new Promise((resolve, reject) => { completeProducer = resolve; failProducer = reject; });
      void completion.catch(() => {});
      const entry = { sourceReady: early, source: null, completion: null, complete: false, file: null, handle: null };
      cache.set(cacheKey, entry);
      releaseToProducer = true;
      let publishTask, publishFailure, durationMs, encoded = true;
      const task = (async () => {
        try {
          if (!folder) folder = createTemporaryAudioDirectory(directory);
          // Opaque cache names remain compatible with the existing orphan sweeper; content is Ogg.
          entry.file = path.join(await folder, `${randomUUID()}.wav`);
          stillCurrent(expected, controller);
          const publish = async event => {
            const facts = sourceFacts(event, encoded); stillCurrent(expected, controller);
            const stat = await fs.stat(entry.file);
            if (stat.size < (encoded ? event.bytes : 44 + event.samples * 4)) throw spotifyError('invalid-response', 'invalid-stream-audio');
            await verifyPrefix(entry.file, facts);
            entry.handle = await media.addGrowing(entry.file, { completion, contentType: encoded ? 'audio/ogg' : 'audio/wav' });
            stillCurrent(expected, controller);
            const actualQuality = facts.bitrate === 160000 ? 'standard' : facts.bitrate === 320000 ? 'high' : null;
            entry.source = { url: entry.handle.url, fetchedAt: Date.now(), quality: actualQuality,
              requestedQuality: quality, actualQuality, streaming: true, sourceInfo: facts };
            if (!encoded) entry.source.preparedAudio = { representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 };
            resolveEarly(entry.source);
          };
          const request = () => native.request({ action: encoded ? 'audio-stream-encoded' : 'audio-stream', trackId: id, output: entry.file, quality }, { signal: controller.signal, onProgress: event => {
            if (event.event === 'metadata') durationMs = event.durationMs;
            if (event.event === 'connecting') onProgress({ stage: 'connect' });
            if (event.event === 'loading') onProgress({ stage: 'download' });
            if (event.event === 'decoding') onProgress({ stage: 'decode', loaded: event.positionMs, total: durationMs, unit: 'milliseconds' });
            if (event.event === 'stream-ready' && !publishTask) {
              publishTask = publish(event).catch(error => { publishFailure = error; controller.abort(); throw error; });
              void publishTask.catch(() => {});
            }
          } });
          let ready;
          try { ready = await request(); }
          catch (error) {
            if (error.code !== 'unsupported' || error.message !== 'Spotify: encoded-format-unsupported' || publishTask || entry.handle) throw error;
            // Retry the same authenticated track/tier only when the chooser explicitly selected MP3.
            // Network/auth/corrupt streams and failures after an early prefix never fall back.
            stillCurrent(expected, controller); await remove(entry.file); encoded = false; ready = await request();
          }
          stillCurrent(expected, controller);
          sourceFacts(ready, encoded);
          const stat = await fs.stat(entry.file);
          if (stat.size !== (encoded ? ready.bytes : 44 + ready.samples * 4) || (encoded && ready.pcmFrames <= 0)) throw spotifyError('invalid-response', 'invalid-stream-audio');
          if (!publishTask) publishTask = publish(ready);
          await publishTask; stillCurrent(expected, controller);
          entry.complete = true; completeProducer(); await entry.handle?.completed;
          onProgress({ stage: 'validate' }); await trimCache(cacheKey);
        } catch (error) {
          const failure = publishFailure || error;
          controller.abort(); failProducer(failure); rejectEarly(failure);
          await publishTask?.catch(() => {}); entry.handle?.revoke();
          if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
          if (entry.file) await remove(entry.file);
          throw failure;
        } finally { if (jobs.get(requestId) === controller) jobs.delete(requestId); }
      })();
      entry.completion = task; pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      return await early;
    } finally { if (!releaseToProducer && jobs.get(requestId) === controller) jobs.delete(requestId); }
  }
  function prepare(id, requestId, onProgress, quality, options = {}) {
    const task = options.streaming === true ? runStreaming(id, requestId, onProgress, quality) : run(id, requestId, onProgress, quality); pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {}); return task;
  }
  return { prepare, cancel(requestId) { jobs.get(requestId)?.abort(); },
    async clear() {
      generation++; for (const controller of jobs.values()) controller.abort(); media.clear();
      const files = [...cache.values()].map(entry => entry.file).filter(Boolean); cache.clear();
      await Promise.allSettled([...pending]);
      await Promise.all([...new Set([...files, ...garbage])].map(remove));
    },
    async close() { await this.clear(); media.close(); if (folder) await closeTemporaryAudioDirectory(await folder).catch(() => {}); },
  };
}
module.exports = { createAudioPreparation };
