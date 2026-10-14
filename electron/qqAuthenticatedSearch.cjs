'use strict';

const path = require('node:path');
const { randomInt } = require('node:crypto');

// electron/qqAuthenticatedSearch.cjs
// The embedded main process keeps device/credentials here.
const PACKAGE = '@yakult-green-tea/qq-music-api';
const PINNED_VERSION = '3.1.2';
const SUPPORTED_VERSIONS = new Set(['3.1.2', '3.1.4']);
const ROUTE = '/user/search';
const UPSTREAM = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

class QqSearchError extends Error {
  constructor(code, status, upstreamCode) {
    super(code);
    this.name = 'QqSearchError';
    this.code = code;
    this.status = status;
    if (Number.isSafeInteger(upstreamCode)) this.upstreamCode = upstreamCode;
  }
}
const error = (code, status, upstreamCode) => new QqSearchError(code, status, upstreamCode);
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, 512) : '';
const mid = value => typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value) ? value : '';
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const integerParam = (value, fallback, max) => {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw error('QQ_SEARCH_INVALID_PARAMETERS', 400);
  return parsed;
};
const searchParams = input => {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 200 || /[\u0000-\u001f\u007f]/.test(input.query)) throw error('QQ_SEARCH_INVALID_PARAMETERS', 400);
  return { query, limit: integerParam(input.limit, 30, 100), page: integerParam(input.page, 1, 1000) };
};

// Only fields already consumed by normalizeQqSong cross into the renderer.
function publicSong(raw) {
  const item = record(raw), album = record(item.album), file = record(item.file);
  const songMid = mid(item.mid ?? item.songmid), id = positive(item.id ?? item.songid);
  const title = text(item.title ?? item.name ?? item.songname);
  if (!songMid || !title) throw error('QQ_SEARCH_INVALID_RESPONSE', 502);
  const singers = Array.isArray(item.singer) ? item.singer : [];
  return {
    ...(id ? { id } : {}), mid: songMid, title,
    interval: nonnegative(item.interval) ?? 0,
    singer: singers.slice(0, 20).map(value => {
      const singer = record(value);
      return { ...(positive(singer.id) ? { id: singer.id } : {}), mid: mid(singer.mid), name: text(singer.name) };
    }),
    album: { ...(positive(album.id) ? { id: album.id } : {}), mid: mid(album.mid), name: text(album.name ?? album.title) },
    file: { media_mid: mid(file.media_mid) },
  };
}

function createAuthenticatedQqSearch({ service, buildAndroidComm, credentialMusicId, isAuthSession, now = Date.now, searchId = () => String(randomInt(10 ** 12, 10 ** 13)) }) {
  if (typeof service?.authFor !== 'function' || typeof service?.http?.post !== 'function'
    || typeof buildAndroidComm !== 'function' || typeof credentialMusicId !== 'function' || typeof isAuthSession !== 'function') {
    throw error('QQ_SEARCH_HOST_UNSUPPORTED', 503);
  }
  const aborted = signal => { if (signal?.aborted) throw error('QQ_SEARCH_CANCELLED', 499); };
  const resolve = async token => {
    if (typeof token !== 'string' || !token || token.length > 16384) throw error('QQ_SEARCH_AUTH_REQUIRED', 401);
    let auth;
    try { auth = await service.authFor(token); }
    catch { throw error('QQ_SEARCH_SESSION_UNAVAILABLE', 503); }
    if (!auth || !isAuthSession(auth) || auth.expiresAt <= now()) throw error('QQ_SEARCH_AUTH_REQUIRED', 401);
    const musicId = credentialMusicId(auth.credential);
    if (!/^\d{1,24}$/.test(musicId) || musicId === '0' || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(auth.credential.musickey)) {
      throw error('QQ_SEARCH_AUTH_REQUIRED', 401);
    }
    return auth;
  };
  return async function search(input, token, { signal } = {}) {
    const params = searchParams(input);
    aborted(signal);
    const auth = await resolve(token);
    aborted(signal);
    const musicId = credentialMusicId(auth.credential);
    const key = auth.credential.musickey;
    const identity = { musicId, key, expiresAt: auth.expiresAt };
    const searchid = searchId();
    if (typeof searchid !== 'string' || !/^\d{8,20}$/.test(searchid)) throw error('QQ_SEARCH_HOST_UNSUPPORTED', 503);
    let response;
    try {
      response = await service.http.post(UPSTREAM, {
        comm: buildAndroidComm(auth.device, auth.credential),
        req_0: {
          module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicMobile',
          param: { searchid, query: params.query, search_type: 0, num_per_page: params.limit,
            page_num: params.page, highlight: true, grp: true, selectors: {}, vec_selectors: [] },
        },
      }, { signal, headers: {
        'User-Agent': `QQMusic 14090008(android ${auth.device.osRelease})`,
        Cookie: `uin=${musicId}; qqmusic_uin=${musicId}; qm_keyst=${key}; qqmusic_key=${key}`,
      } });
    } catch {
      aborted(signal);
      // Axios config, raw upstream messages and credential material never escape.
      throw error('QQ_SEARCH_NETWORK_FAILURE', 502);
    }
    aborted(signal);
    const current = await resolve(token);
    aborted(signal);
    if (credentialMusicId(current.credential) !== identity.musicId || current.credential.musickey !== identity.key
      || current.expiresAt !== identity.expiresAt) throw error('QQ_SEARCH_AUTH_REQUIRED', 401);
    if (response.status !== 200) throw error('QQ_SEARCH_NETWORK_FAILURE', 502);
    const envelope = record(response.data), branch = record(envelope.req_0), data = record(branch.data);
    for (const node of [envelope, branch]) {
      if (!Number.isSafeInteger(node.code)) throw error('QQ_SEARCH_INVALID_RESPONSE', 502);
      if (node.code !== 0) throw error('QQ_SEARCH_UPSTREAM_REJECTED', 502, node.code);
    }
    if (data.code !== undefined && data.code !== 0) {
      if (!Number.isSafeInteger(data.code)) throw error('QQ_SEARCH_INVALID_RESPONSE', 502);
      throw error('QQ_SEARCH_UPSTREAM_REJECTED', 502, data.code);
    }
    const items = record(data.body).item_song;
    if (!Array.isArray(items) || items.length > params.limit) throw error('QQ_SEARCH_INVALID_RESPONSE', 502);
    const meta = record(data.meta), songs = items.map(publicSong);
    const nextPage = Number.isSafeInteger(meta.nextpage) && (meta.nextpage === -1 || meta.nextpage > params.page) ? meta.nextpage : undefined;
    return { code: 200, data: { songs, page: params.page, limit: params.limit,
      ...(nonnegative(meta.sum) === undefined ? {} : { total: meta.sum }),
      ...(nextPage === undefined ? {} : { hasMore: nextPage !== -1 }),
    } };
  };
}

function createQqSearchMiddleware({ search, getAuthToken }) {
  return async (ctx, next) => {
    if (ctx.path !== ROUTE) return next();
    ctx.set('Cache-Control', 'no-store');
    if (ctx.method !== 'GET') { ctx.status = 405; ctx.set('Allow', 'GET'); ctx.body = { code: 'QQ_SEARCH_METHOD_NOT_ALLOWED' }; return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.req.once('aborted', abort);
    ctx.res.once('close', abort);
    try {
      const token = getAuthToken(ctx);
      ctx.body = await search({ query: ctx.query.query, limit: ctx.query.limit, page: ctx.query.page }, token, { signal: controller.signal });
      ctx.status = 200;
    } catch (failure) {
      const known = failure instanceof QqSearchError ? failure : error('QQ_SEARCH_HOST_FAILURE', 502);
      ctx.status = known.status;
      ctx.body = { code: known.code, ...(known.upstreamCode === undefined ? {} : { upstreamCode: known.upstreamCode }) };
    } finally {
      ctx.req.removeListener('aborted', abort);
      ctx.res.removeListener('close', abort);
    }
  };
}

function installQqAuthenticatedSearch(qqApi, { packageJsonPath, loadModule = require } = {}) {
  const app = qqApi?.default;
  if (typeof app?.use !== 'function') return false;
  const manifestPath = packageJsonPath || require.resolve(`${PACKAGE}/package.json`);
  if (!SUPPORTED_VERSIONS.has(loadModule(manifestPath).version)) return false;
  // These paths are a version-pinned adapter. Never derive a module or upstream URL from a request.
  const root = path.dirname(manifestPath);
  const nodeAuth = loadModule(path.join(root, 'dist/src/services/auth/qrLogin.node.js'));
  const protocol = loadModule(path.join(root, 'dist/src/services/auth/qrLogin.js'));
  const android = loadModule(path.join(root, 'dist/src/services/auth/androidDevice.js'));
  const controller = loadModule(path.join(root, 'dist/src/controllers/login.js'));
  const service = nodeAuth.qrLoginService;
  const search = createAuthenticatedQqSearch({ service, buildAndroidComm: protocol.buildAndroidComm,
    credentialMusicId: android.credentialMusicId, isAuthSession: protocol.isAuthSession });
  app.use(createQqSearchMiddleware({ search, getAuthToken: controller.getAuthToken }));
  return true;
}

module.exports = { PINNED_VERSION, ROUTE, QqSearchError, createAuthenticatedQqSearch, createQqSearchMiddleware, installQqAuthenticatedSearch };
