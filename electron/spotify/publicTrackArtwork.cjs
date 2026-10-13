'use strict';

// electron/spotify/publicTrackArtwork.cjs — credential-free, bounded official track oEmbed artwork only.
const PUBLIC_ARTWORK_LIMITS = Object.freeze({ bodyBytes: 32768, chunks: 128, timeoutMs: 8000,
  pageBudgetMs: 20000, pageTracks: 50, parallel: 6, pending: 100, cacheEntries: 500 });
const PUBLIC_ARTWORK_TTL_MS = 60000, PUBLIC_ARTWORK_MISSING_TTL_MS = 15000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const missing = () => ({ status: 'unavailable' });
const endpoint = id => `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`;
const boundedTime = (value, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : max;
const discard = response => { if (response?.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {}); };

// Only the exact verified track identity and documented/observed Spotify image hosts are accepted.
function parsePublicTrackArtwork(value, id) {
  if (!validId(id) || !value || typeof value !== 'object' || Array.isArray(value)
    || value.provider_name !== 'Spotify' || value.provider_url !== 'https://spotify.com' || value.type !== 'rich') return missing();
  const iframe = value.iframe_url, thumbnail = value.thumbnail_url;
  if (typeof iframe !== 'string' || typeof thumbnail !== 'string' || iframe.length > 256 || thumbnail.length > 256) return missing();
  let url;
  try { url = new URL(iframe); } catch { return missing(); }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || url.hash
    || url.pathname !== `/embed/track/${id}` || !['', '?utm_source=oembed'].includes(url.search)
    || iframe !== `https://open.spotify.com/embed/track/${id}${url.search}`) return missing();
  // No subdomain suffix matching, query strings, alternate paths, or playlist-cover substitution.
  if (!/^https:\/\/(?:image-cdn-fa\.spotifycdn\.com|image-cdn-ak\.spotifycdn\.com|i\.scdn\.co)\/image\/[a-f0-9]{40}$/.test(thumbnail)) return missing();
  return { status: 'available', source: 'spotify-oembed', url: thumbnail, sourceUrl: endpoint(id) };
}

// Bound decoded streaming bytes, chunks, UTF-8 and JSON; never read or render the iframe HTML.
async function readJson(response, signal) {
  const length = response.headers?.get('content-length'), type = response.headers?.get('content-type') || '';
  if ((length && /^\d+$/.test(length) && Number(length) > PUBLIC_ARTWORK_LIMITS.bodyBytes)
    || !/^application\/json(?:;|$)/i.test(type) || !response.body?.getReader) throw new Error('invalid-artwork');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, finished = false;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('cancelled-artwork');
      const next = await reader.read();
      if (signal.aborted) throw new Error('cancelled-artwork');
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new Error('invalid-artwork');
      bytes += next.value.byteLength;
      if (bytes > PUBLIC_ARTWORK_LIMITS.bodyBytes || chunks.length >= PUBLIC_ARTWORK_LIMITS.chunks) throw new Error('large-artwork');
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

// Shared FIFO has six global slots. Each page has a deadline and at most fifty unique lookups.
function createPublicTrackArtwork({ fetcher = fetch, now = Date.now, timeoutMs, pageBudgetMs } = {}) {
  const cache = new Map(), pending = new Map(), queue = [];
  const requestTimeout = boundedTime(timeoutMs, PUBLIC_ARTWORK_LIMITS.timeoutMs);
  const pageTimeout = boundedTime(pageBudgetMs, PUBLIC_ARTWORK_LIMITS.pageBudgetMs);
  let generation = 0, active = 0, retryAt = 0;
  function finish(task, result, cacheable = true) {
    if (task.settled) return;
    task.settled = true;
    if (pending.get(task.id) === task) pending.delete(task.id);
    if (cacheable && task.expected === generation && task.users.size && (!task.controller?.signal.aborted || task.timedOut)) {
      cache.delete(task.id);
      while (cache.size >= PUBLIC_ARTWORK_LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
      cache.set(task.id, { result, expiresAt: now() + (result.status === 'available' ? PUBLIC_ARTWORK_TTL_MS : PUBLIC_ARTWORK_MISSING_TTL_MS) });
    }
    task.resolve(result);
  }
  async function load(task) {
    const controller = new AbortController(); task.controller = controller;
    const timer = setTimeout(() => { task.timedOut = true; controller.abort(); }, requestTimeout);
    let onAbort;
    const aborted = new Promise(resolve => {
      onAbort = () => resolve(missing());
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = async () => {
        const url = endpoint(task.id);
        const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
          credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', signal: controller.signal });
        try {
          if (task.expected !== generation || controller.signal.aborted || task.settled || !task.users.size) return missing();
          if (response.redirected || (response.url && response.url !== url)) return missing();
          if (response.status === 429) {
            const header = response.headers?.get('retry-after');
            const seconds = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : NaN;
            const date = typeof header === 'string' ? Date.parse(header) : NaN;
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now() : 60000;
            retryAt = Math.max(retryAt, now() + Math.max(1000, Math.min(86400000, delay)));
            return missing();
          }
          if (!response.ok) return missing();
          const json = await readJson(response, controller.signal);
          return task.expected === generation && !controller.signal.aborted ? parsePublicTrackArtwork(json, task.id) : missing();
        } finally { discard(response); }
      };
      return await Promise.race([work().catch(() => missing()), aborted]);
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  }
  function pump() {
    while (active < PUBLIC_ARTWORK_LIMITS.parallel && queue.length) {
      const task = queue.shift();
      if (task.settled) continue;
      // Timer callbacks can interleave: do not start another page's work after its deadline.
      for (const consumer of task.users) if (consumer.expiresAt <= Date.now()) task.users.delete(consumer);
      if (task.expected !== generation || !task.users.size || now() < retryAt) { finish(task, missing(), false); continue; }
      active++;
      void load(task).then(result => finish(task, result), () => finish(task, missing()))
        .finally(() => { active--; pump(); });
    }
  }
  function acquire(id, consumer) {
    const cached = cache.get(id);
    if (cached?.expiresAt > now()) return { promise: Promise.resolve(cached.result) };
    cache.delete(id);
    let task = pending.get(id);
    if (!task) {
      if (now() < retryAt || pending.size >= PUBLIC_ARTWORK_LIMITS.pending) return { promise: Promise.resolve(missing()) };
      task = { id, expected: generation, users: new Set(), settled: false };
      task.promise = new Promise(resolve => { task.resolve = resolve; });
      pending.set(id, task); queue.push(task);
    }
    task.users.add(consumer);
    return task;
  }
  return {
    async enrich(rows) {
      const consumer = { expiresAt: Date.now() + pageTimeout }, tasks = new Map(), results = new Map(), expected = generation;
      // Deduplicate requests only; callers receive every original row in its original position.
      for (const row of rows) {
        if (!validId(row?.id) || tasks.has(row.id) || tasks.size >= PUBLIC_ARTWORK_LIMITS.pageTracks) continue;
        tasks.set(row.id, acquire(row.id, consumer));
      }
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, pageTimeout); });
      const work = Promise.all([...tasks].map(async ([id, task]) => { results.set(id, await task.promise); }));
      pump();
      try {
        await Promise.race([work, deadline]);
        return rows.map(row => ({ ...row, artwork: structuredClone(expected === generation ? results.get(row.id) || missing() : missing()) }));
      } finally {
        clearTimeout(timer);
        for (const task of tasks.values()) {
          if (!task.users) continue;
          task.users.delete(consumer);
          if (!task.users.size && !task.settled) { task.controller?.abort(); finish(task, missing(), false); }
        }
        // Remove abandoned queued work immediately, keeping the queue bounded on repeated timeouts.
        for (let index = queue.length - 1; index >= 0; index--) if (queue[index].settled) queue.splice(index, 1);
        pump();
      }
    },
    clear() {
      generation++; cache.clear(); retryAt = 0;
      for (const task of pending.values()) { task.controller?.abort(); finish(task, missing(), false); }
      pending.clear(); queue.length = 0;
    },
  };
}
module.exports = { createPublicTrackArtwork, parsePublicTrackArtwork, PUBLIC_ARTWORK_LIMITS,
  PUBLIC_ARTWORK_TTL_MS, PUBLIC_ARTWORK_MISSING_TTL_MS };
