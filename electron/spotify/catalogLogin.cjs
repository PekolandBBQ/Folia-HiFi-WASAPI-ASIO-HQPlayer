const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { spotifyError } = require('./errors.cjs');
const { CATALOG_SCOPES, mergeGrantedScope } = require('./grantScopes.cjs');

// Separate PKCE authorization for catalog access; the callback and credentials stay on this machine.
const NCSPOT_CLIENT_ID = 'd420a117a32841c2b3474932e49fb54b';
function createCatalogLogin({ vault, fetcher = fetch, renderQr, openAuthorization, clientId = NCSPOT_CLIENT_ID,
  port = 8989, redirectUri, now = Date.now }) {
  let active, generation = 0;
  const current = entry => active === entry && entry.generation === generation && now() < entry.expiresAt;
  function stop(entry) { clearTimeout(entry?.timer); entry?.server?.close(); entry?.server?.closeAllConnections(); }
  function cancel(key) {
    if (active?.key !== key) return;
    const entry = active; active = null; entry.controller.abort(); stop(entry);
  }
  async function begin() {
    if (active) cancel(active.key);
    if (!/^[a-f0-9]{32}$/.test(clientId)) throw spotifyError('invalid-response', 'invalid-client-id');
    let callbackPath = '/login', callbackPort = port;
    if (redirectUri) {
      let callback;
      try { callback = new URL(redirectUri); } catch { throw spotifyError('invalid-response', 'invalid-redirect-uri'); }
      if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.username || callback.password
        || callback.search || callback.hash || !/^\/[a-zA-Z0-9/_-]+$/.test(callback.pathname)) throw spotifyError('invalid-response', 'invalid-redirect-uri');
      callbackPath = callback.pathname; callbackPort = Number(callback.port);
    }
    const entry = { key: randomUUID(), generation, epoch: vault.epoch(), expiresAt: now() + 600000,
      verifier: randomBytes(48).toString('base64url'), state: randomBytes(32).toString('base64url'),
      status: 'waiting', controller: new AbortController() };
    active = entry;
    entry.server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
      if (req.method === 'GET' && req.headers.host === `127.0.0.1:${entry.port}` && url.pathname === `/complete/${entry.key}` && entry.status === 'confirmed') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Folia · Spotify</title><style>body{font:16px system-ui,sans-serif;background:#e6eaed;color:#24313b;display:grid;place-items:center;min-height:90vh}main{padding:2rem;border:1px solid #fff;border-radius:24px;background:#ffffff90;max-width:28rem}h1{font-size:1.4rem}p{line-height:1.6}</style><main><h1>Spotify 授权已完成</h1><p>请返回 Folia。可以关闭此页面。</p><p>Authorization complete. Return to Folia.</p></main></html>'); return;
      }
      if (req.method !== 'GET' || url.pathname !== callbackPath || req.headers.host !== `127.0.0.1:${entry.port}`) { res.writeHead(404).end(); return; }
      if (!current(entry) || entry.status !== 'waiting' || url.searchParams.get('state') !== entry.state) { res.writeHead(400).end('Invalid or expired authorization.'); return; }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 4096) {
        entry.status = 'error'; res.end('Authorization was not completed. Return to Folia to retry.'); stop(entry); return;
      }
      entry.status = 'scanned';
      try {
        const response = await fetcher('https://accounts.spotify.com/api/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(25000)]),
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
            code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier }),
        });
        if (!response.ok) throw spotifyError('auth-required', 'catalog-authorization-failed');
        const value = await response.json();
        if (!current(entry) || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw spotifyError('auth-required', 'catalog-authorization-expired');
        await vault.save({ access_token: value.access_token, refresh_token: value.refresh_token, clientId,
          expiresAt: now() + value.expires_in * 1000, scope: mergeGrantedScope(null, value) }, entry.epoch, () => current(entry));
        entry.status = 'confirmed'; entry.imageUrl = ''; entry.verifier = ''; entry.state = '';
        res.writeHead(303, { Location: `/complete/${entry.key}` }).end();
      } catch { entry.status = 'error'; res.writeHead(400).end('Authorization failed. Return to Folia to retry.'); }
      finally {
        clearTimeout(entry.timer);
        // Let the browser finish navigating to a clean URL without OAuth parameters.
        entry.timer = setTimeout(() => stop(entry), 60000); entry.timer.unref?.();
      }
    });
    entry.server.headersTimeout = 10000; entry.server.requestTimeout = 30000;
    try {
      await new Promise((resolve, reject) => { entry.server.once('error', reject); entry.server.listen(callbackPort, '127.0.0.1', resolve); });
      if (!current(entry)) throw spotifyError('auth-required', 'session-changed');
      entry.port = entry.server.address().port; entry.redirectUri = `http://127.0.0.1:${entry.port}${callbackPath}`;
      const url = new URL('https://accounts.spotify.com/authorize');
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: entry.redirectUri,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(entry.verifier).digest('base64url'),
        state: entry.state, scope: CATALOG_SCOPES }).toString();
      entry.imageUrl = await renderQr(url.href);
      if (!current(entry)) throw spotifyError('auth-required', 'session-changed');
      entry.timer = setTimeout(() => cancel(entry.key), 600000); entry.timer.unref?.();
      await openAuthorization?.(url.href);
      return entry.key;
    } catch { cancel(entry.key); throw spotifyError('unavailable', 'catalog-login-start-failed'); }
  }
  return { begin, cancel, image: key => active?.key === key ? active.imageUrl : '',
    check(key) { return { state: active?.key === key && current(active) ? active.status : 'expired' }; },
    clear() { generation++; if (active) cancel(active.key); } };
}
module.exports = { createCatalogLogin, NCSPOT_CLIENT_ID };
