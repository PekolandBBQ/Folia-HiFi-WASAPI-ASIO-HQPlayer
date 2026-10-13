'use strict';
const { spotifyError } = require('./errors.cjs');
const { parse: parseHtml, defaultTreeAdapter } = require('parse5');

// Public embed metadata only: no browser session, credentials, scripts, playback or disk cache.
const PUBLIC_PLAYLIST_CACHE_TTL_MS = 60000;
const PUBLIC_PLAYLIST_LIMITS = Object.freeze({ bodyBytes: 2 * 1024 * 1024, htmlNodes: 20000, htmlDepth: 256, tracks: 1000, chunks: 8192, timeoutMs: 12000, cacheEntries: 20, pendingRequests: 20 });
const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (reason, code = 'invalid-response') => spotifyError(code, `public-playlist-${reason}`);

// Accept IDs or exact official HTTPS playlist paths, then discard all supplied URL options.
function publicPlaylistId(input) {
  if (typeof input !== 'string' || input.length > 2048) throw failure('invalid-url');
  if (PLAYLIST_ID.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { throw failure('invalid-url'); }
  const path = /^https:\/\/open\.spotify\.com\/(?:embed\/)?playlist\/([A-Za-z0-9]{22})\/?(?:[?#][^\r\n\t\\]*)?$/.exec(input);
  if (!/^https:\/\/open\.spotify\.com\//.test(input) || url.protocol !== 'https:' || url.hostname !== 'open.spotify.com'
    || url.port || url.username || url.password || !path || /[\\\r\n\t]/.test(input)) throw failure('invalid-url');
  return path[1];
}
const embedUrl = id => `https://open.spotify.com/embed/playlist/${id}`;
const pageUrl = id => `https://open.spotify.com/playlist/${id}`;
const textValue = (value, max, required = false) => typeof value === 'string' && value.length <= max
  && (!required || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? value : null;

// Use HTML5 parsing rather than matching source text: quoted attributes and raw-text contexts matter.
function boundedHtmlDocument(html) {
  let budget = PUBLIC_PLAYLIST_LIMITS.htmlNodes;
  const consume = () => { if (--budget < 0) throw failure('limit'); };
  const depths = new WeakMap(), adapter = { ...defaultTreeAdapter };
  for (const name of ['createDocument', 'createDocumentFragment', 'createElement', 'createCommentNode', 'createTextNode',
    'setDocumentType', 'insertText', 'insertTextBefore']) {
    adapter[name] = (...args) => { consume(); return defaultTreeAdapter[name](...args); };
  }
  for (const name of ['appendChild', 'insertBefore']) {
    adapter[name] = (parent, child, ...rest) => {
      const depth = (depths.get(parent) || 0) + 1;
      if (depth > PUBLIC_PLAYLIST_LIMITS.htmlDepth) throw failure('limit');
      depths.set(child, depth);
      return defaultTreeAdapter[name](parent, child, ...rest);
    };
  }
  return parseHtml(html, { treeAdapter: adapter,
    // This flag controls HTML noscript parsing only. parse5 never executes any JavaScript.
    scriptingEnabled: true,
    onParseError(error) {
      consume();
      if (error.code === 'duplicate-attribute') throw failure('schema');
    },
  });
}

// Read the one genuine HTML JSON script; never traverse template fragments or foreign-content trees.
function readNextData(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > PUBLIC_PLAYLIST_LIMITS.bodyBytes) throw failure('limit');
  const document = boundedHtmlDocument(html), pending = [document];
  let selected;
  while (pending.length) {
    const node = pending.pop();
    if (node.nodeName === '#document-fragment' || node.tagName === 'template'
      || (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml')) continue;
    if (node.tagName === 'script') {
      const attributes = new Map(node.attrs.map(attribute => [attribute.name, attribute.value]));
      if (attributes.get('id') === '__NEXT_DATA__') {
        if (selected !== undefined || attributes.get('type') !== 'application/json' || attributes.has('src')
          || node.childNodes.some(child => child.nodeName !== '#text')) throw failure('schema');
        selected = node.childNodes.map(child => child.value).join('');
      }
      continue;
    }
    for (const child of node.childNodes || []) pending.push(child);
  }
  if (selected === undefined) throw failure('schema');
  try { return JSON.parse(selected); } catch { throw failure('schema'); }
}

function publicImages(entity) {
  const sources = entity.coverArt?.sources;
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 6).flatMap(source => {
    if (!plain(source) || typeof source.url !== 'string' || source.url.length > 2048) return [];
    let url;
    try { url = new URL(source.url); } catch { return []; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !(url.hostname.endsWith('.spotifycdn.com') || ['i.scdn.co', 'mosaic.scdn.co'].includes(url.hostname))) return [];
    return [{ url: url.href, height: Number.isSafeInteger(source.height) && source.height > 0 ? source.height : null,
      width: Number.isSafeInteger(source.width) && source.width > 0 ? source.width : null }];
  });
}

// The verified embed schema exposes rows, not an authoritative total. A row count is never a total.
function parsePublicPlaylistMetadata(html, input, { fetchedAt = Date.now() } = {}) {
  const id = publicPlaylistId(input), root = readNextData(html);
  const page = root?.props?.pageProps;
  if (!plain(root) || !plain(page) || !plain(page.state)) throw failure('schema');
  const entity = page.state.data?.entity;
  if (entity == null || (plain(entity) && Object.keys(entity).length === 0)) throw failure('unavailable', 'unavailable');
  if (!plain(entity) || entity.type !== 'playlist' || entity.id !== id || entity.uri !== `spotify:playlist:${id}`) throw failure('schema');
  const name = textValue(entity.name, 1024, true);
  if (!name || !Array.isArray(entity.trackList)) throw failure('schema');
  if (entity.isPublic === false || entity.isPrivate === true || entity.isUnavailable === true) throw failure('unavailable', 'unavailable');
  if (entity.trackList.length === 0) throw failure('unavailable', 'unavailable');
  const tracks = [], partialReasons = ['unknown-total'];
  const rows = entity.trackList.slice(0, PUBLIC_PLAYLIST_LIMITS.tracks);
  let invalidCount = 0;
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position], uri = plain(row) && typeof row.uri === 'string' && TRACK_URI.exec(row.uri);
    const title = plain(row) && textValue(row.title, 1024, true);
    const subtitle = plain(row) && textValue(row.subtitle, 2048);
    if (!uri || !title || subtitle === null || subtitle === false
      || (row.entityType !== undefined && row.entityType !== 'track')) { invalidCount++; continue; }
    const validDuration = Number.isSafeInteger(row.duration) && row.duration >= 0 && row.duration <= 86400000;
    if (!validDuration && !partialReasons.includes('incomplete-track-metadata')) partialReasons.push('incomplete-track-metadata');
    tracks.push({ id: uri[1], uri: row.uri, title, subtitle, durationMs: validDuration ? row.duration : null, position,
      source: 'public_embed', sourceUrl: `https://open.spotify.com/track/${uri[1]}` });
  }
  if (!tracks.length) throw failure('schema');
  if (invalidCount) partialReasons.push('invalid-items');
  if (rows.length < entity.trackList.length) partialReasons.push('truncated');
  return { id, uri: entity.uri, name, description: textValue(entity.description, 4096), images: publicImages(entity), owner: null,
    tracks, total: null, complete: false, partial: true, receivedCount: entity.trackList.length,
    omittedCount: entity.trackList.length - tracks.length, partialReasons,
    source: 'public_embed', sourceUrl: embedUrl(id), playlistUrl: pageUrl(id), fetchedAt };
}

// Stream counting bounds the decoded response too; Content-Length alone is not trustworthy.
async function readBoundedHtml(response, signal) {
  const declaredLength = response.headers?.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > PUBLIC_PLAYLIST_LIMITS.bodyBytes) throw failure('limit');
  const contentType = response.headers?.get('content-type') || '';
  if (!/^text\/html(?:;|$)/i.test(contentType) || !response.body || typeof response.body.getReader !== 'function') throw failure('schema');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, finished = false;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw failure('cancelled', 'unavailable');
      const next = await reader.read();
      if (signal.aborted) throw failure('cancelled', 'unavailable');
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array)) throw failure('schema');
      bytes += next.value.byteLength;
      if (bytes > PUBLIC_PLAYLIST_LIMITS.bodyBytes || chunks.length >= PUBLIC_PLAYLIST_LIMITS.chunks) throw failure('limit');
      chunks.push(Buffer.from(next.value));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw failure('schema'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

// Short memory-only success cache with shared in-flight work and generation-safe cancellation.
function createPublicPlaylistMetadata({ fetcher = fetch, now = Date.now, timeoutMs = PUBLIC_PLAYLIST_LIMITS.timeoutMs } = {}) {
  const cache = new Map(), pending = new Map(), controllers = new Set();
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, PUBLIC_PLAYLIST_LIMITS.timeoutMs) : PUBLIC_PLAYLIST_LIMITS.timeoutMs;
  let generation = 0;
  async function load(id, expected) {
    const controller = new AbortController(); controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(failure(timedOut ? 'timeout' : 'cancelled', timedOut ? 'network' : 'unavailable'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = async () => {
        const url = embedUrl(id);
        const response = await fetcher(url, { method: 'GET', headers: { Accept: 'text/html' }, redirect: 'error',
          credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', signal: controller.signal });
        const discard = () => { if (response.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {}); };
        if (expected !== generation || controller.signal.aborted) { discard(); throw failure('cancelled', 'unavailable'); }
        if (response.redirected || (response.url && response.url !== url)) { discard(); throw failure('redirect', 'network'); }
        if (!response.ok) {
          discard();
          const code = [401, 403, 404].includes(response.status) ? 'unavailable' : 'network';
          throw failure(code, code);
        }
        let html;
        try { html = await readBoundedHtml(response, controller.signal); }
        finally { discard(); }
        if (expected !== generation || controller.signal.aborted) throw failure('cancelled', 'unavailable');
        return parsePublicPlaylistMetadata(html, id, { fetchedAt: now() });
      };
      const result = await Promise.race([work(), aborted]);
      if (expected !== generation || controller.signal.aborted) throw failure('cancelled', 'unavailable');
      while (cache.size >= PUBLIC_PLAYLIST_LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
      cache.set(id, { result, expiresAt: now() + PUBLIC_PLAYLIST_CACHE_TTL_MS });
      return result;
    } catch (error) {
      if (expected !== generation) throw failure('cancelled', 'unavailable');
      if (timedOut) throw failure('timeout', 'network');
      if (typeof error?.message === 'string' && /^Spotify: public-playlist-[a-z-]+$/.test(error.message)) throw error;
      throw failure('network', 'network');
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controllers.delete(controller);
    }
  }
  return {
    async get(input) {
      const id = publicPlaylistId(input), entry = cache.get(id);
      if (entry && entry.expiresAt > now()) return structuredClone(entry.result);
      cache.delete(id);
      let task = pending.get(id);
      if (!task) {
        if (pending.size >= PUBLIC_PLAYLIST_LIMITS.pendingRequests) throw failure('limit');
        task = load(id, generation).finally(() => { if (pending.get(id) === task) pending.delete(id); });
        pending.set(id, task);
      }
      return structuredClone(await task);
    },
    clear() { generation++; cache.clear(); pending.clear(); for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}
module.exports = { createPublicPlaylistMetadata, parsePublicPlaylistMetadata, publicPlaylistId,
  PUBLIC_PLAYLIST_CACHE_TTL_MS, PUBLIC_PLAYLIST_LIMITS };
