'use strict';
const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { sourceErrorCode } = require('../debug/privatePreviewDiagnosticSchema.cjs');

// A main-owned Connect pairing bridge, not an appliance administration proxy.
// Construction is inert: only explicit setup starts the owned guest and mDNS.
const TYPE = '_spotify-connect._tcp.local';
const fail = code => Object.assign(new Error(`Spotify discovery: ${code}`), { code });
const port = value => Number.isInteger(value) && value > 0 && value < 65536;
const identity = value => typeof value === 'string' && /^[\x20-\x7e]{1,256}$/.test(value);
const normalizeAddress = value => value?.startsWith('::ffff:') ? value.slice(7) : value;
const channelValid = value => value && port(value.soloistPort) && Number.isSafeInteger(value.appliancePid) && value.appliancePid > 0
  && typeof value.applianceStartedAt === 'string' && Number.isFinite(Date.parse(value.applianceStartedAt));
const sameChannel = (a, b) => channelValid(b) && ['soloistPort', 'appliancePid', 'applianceStartedAt'].every(key => a[key] === b[key]);
const snapshotValid = (value, now, maximumAge) => value && identity(value.zeroConf?.deviceID)
  && Number.isSafeInteger(value.receivedAt) && value.receivedAt <= now && now - value.receivedAt <= maximumAge;
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(fail('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function publicInfo(bytes, expectedID, expectedName) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail('DISCOVERY_PROTOCOL_INVALID'); }
  if (!value || Array.isArray(value) || value.deviceID !== expectedID || value.remoteName !== expectedName
    || !Number.isSafeInteger(value.status) || !Number.isSafeInteger(value.spotifyError)) throw fail('DISCOVERY_IDENTITY_CHANGED');
  return value;
}
function addresses(interfaces) {
  return [...new Set(Object.values(interfaces).flat().filter(value => value
    && (value.family === 'IPv4' || value.family === 4) && value.internal === false
    && net.isIPv4(value.address) && !value.address.startsWith('127.') && value.address !== '0.0.0.0'
    && Number(value.address.split('.')[0]) < 224).map(value => value.address))];
}
function pairingRequest(request, bytes) {
  if (typeof request.url !== 'string' || request.url.length > 2048 || !/^\/zc(?:\?|$)/.test(request.url)
    || /[\r\n\0#\\]/.test(request.url)) throw fail('REQUEST_NOT_ALLOWED');
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/zc' || !['GET', 'POST'].includes(request.method)) throw fail('REQUEST_NOT_ALLOWED');
  if (request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') throw fail('REQUEST_NOT_ALLOWED');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw fail('REQUEST_NOT_ALLOWED'); }
  const form = new URLSearchParams(source);
  const queryActions = url.searchParams.getAll('action'), formActions = form.getAll('action');
  if (queryActions.length > 1 || formActions.length > 1 || (queryActions.length && formActions.length && queryActions[0] !== formActions[0])) throw fail('REQUEST_NOT_ALLOWED');
  const action = queryActions[0] || formActions[0];
  if (request.method === 'GET' && (action !== 'getInfo' || bytes.length)) throw fail('REQUEST_NOT_ALLOWED');
  if (request.method === 'POST' && (action !== 'addUser'
    || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || ''))) throw fail('REQUEST_NOT_ALLOWED');
  return { action, path: `/zc${url.search}`, method: request.method };
}

function createSoloistDiscovery({ getChannel, readFresh, deviceName,
  networkInterfaces = os.networkInterfaces, createMdns = options => require('multicast-dns')(options),
  createServer = http.createServer, requestHttp = http.request, observe = () => {}, now = Date.now,
  timeoutMs = 15000, maximumBodyBytes = 65536, maximumFreshAgeMs = 5000 } = {}) {
  if (process.type === 'renderer' || typeof getChannel !== 'function' || typeof readFresh !== 'function'
    || typeof deviceName !== 'string' || !deviceName.trim() || Buffer.byteLength(deviceName) > 256 || /[\r\n\0]/.test(deviceName)
    || ![networkInterfaces, createMdns, createServer, requestHttp, observe, now].every(value => typeof value === 'function')
    || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000
    || !Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 1024 || maximumBodyBytes > 65536
    || !Number.isInteger(maximumFreshAgeMs) || maximumFreshAgeMs < 50 || maximumFreshAgeMs > 10000) throw fail('INVALID_REQUEST');
  let closed = false, starting, current, closePromise;
  const lifetime = new AbortController(), activeRequests = new Set();
  const report = value => { try { observe(Object.freeze(value)); } catch { /* Diagnostics cannot break playback or pairing. */ } };
  function transfer(channel, target, body, signal) {
    return new Promise((resolve, reject) => {
      let outgoing, incoming, done = false, length = 0; const chunks = [];
      const finish = (error, result) => {
        if (done) return; done = true; signal.removeEventListener('abort', abort);
        if (error) { outgoing?.destroy(); incoming?.destroy(); }
        for (const chunk of chunks) chunk.fill(0);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(fail('CANCELLED'));
      if (signal.aborted) { abort(); return; }
      try {
        outgoing = requestHttp({ hostname: '127.0.0.1', family: 4, port: channel.soloistPort, path: target.path,
          method: target.method, agent: false, headers: { 'content-type': target.method === 'POST' ? 'application/x-www-form-urlencoded' : 'application/json',
            'content-length': body.length, 'user-agent': 'Folia-Connect-Bridge' } }, value => {
          incoming = value;
          if (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599) { finish(fail('DISCOVERY_PROTOCOL_INVALID')); return; }
          const declared = value.headers['content-length'];
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBodyBytes)) { finish(fail('RESPONSE_TOO_LARGE')); return; }
          value.on('data', chunk => {
            if (done) return; length += chunk.length;
            if (length > maximumBodyBytes) finish(fail('RESPONSE_TOO_LARGE')); else chunks.push(Buffer.from(chunk));
          });
          value.on('error', () => finish(fail('DISCOVERY_UNAVAILABLE')));
          value.on('aborted', () => finish(fail('DISCOVERY_UNAVAILABLE')));
          value.on('end', () => finish(null, { status: value.statusCode, bytes: Buffer.concat(chunks, length) }));
        });
        outgoing.on('error', () => finish(fail('DISCOVERY_UNAVAILABLE')));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        outgoing.end(body);
      } catch { finish(fail('DISCOVERY_UNAVAILABLE')); }
    });
  }
  async function trusted(channel, deviceID, signal, readStartupFresh) {
    const before = await abortable(Promise.resolve().then(() => getChannel({ signal })), signal);
    if (!sameChannel(channel, before)) throw fail('DISCOVERY_IDENTITY_CHANGED');
    const snapshot = await readStartupFresh();
    if (!snapshotValid(snapshot, now(), maximumFreshAgeMs) || snapshot.zeroConf.deviceID !== deviceID) throw fail('DISCOVERY_IDENTITY_CHANGED');
    const after = await abortable(Promise.resolve().then(() => getChannel({ signal })), signal);
    if (!sameChannel(channel, after)) throw fail('DISCOVERY_IDENTITY_CHANGED');
  }
  async function verifyCurrentChannel(channel, signal) {
    const current = await abortable(Promise.resolve().then(() => getChannel({ signal })), signal);
    if (!sameChannel(channel, current)) throw fail('DISCOVERY_IDENTITY_CHANGED');
  }
  async function start({ signal } = {}) {
    if (closed || signal?.aborted) throw fail('CANCELLED');
    if (!starting) {
      starting = (async () => {
        const controller = new AbortController();
        const cancel = () => controller.abort(); lifetime.signal.addEventListener('abort', cancel, { once: true });
        signal?.addEventListener('abort', cancel, { once: true });
        let timedOut = false, stage = 'channel', attempt = 0, readinessCause;
        const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
        const state = { channel: null, deviceID: null, servers: [], publishers: [], timers: [], sockets: new Set() };
        current = state;
        // A missing startup listener may recover, but never reuse an old proof,
        // cross an appliance lease, reset the deadline, or retry a pairing write.
        const readStartupFresh = async () => {
          attempt = 0; readinessCause = undefined;
          for (;;) {
            attempt++;
            try {
              const snapshot = await abortable(Promise.resolve().then(() => readFresh({ signal: controller.signal })), controller.signal);
              readinessCause = undefined; return snapshot;
            } catch (error) {
              if (error?.code !== 'SOLOIST_STARTING' || controller.signal.aborted) throw error;
              readinessCause = 'SOLOIST_STARTING';
              report({ event: 'discovery-retry', phase: 'retry', stage, errorCode: readinessCause, attempt });
              try { await delay(250, undefined, { signal: controller.signal }); }
              catch (error) { if (controller.signal.aborted) throw fail('CANCELLED'); throw error; }
              await verifyCurrentChannel(state.channel, controller.signal);
            }
          }
        };
        try {
          const channel = await abortable(Promise.resolve().then(() => getChannel({ signal: controller.signal })), controller.signal);
          if (!channelValid(channel)) throw fail('DISCOVERY_IDENTITY_CHANGED');
          state.channel = Object.freeze({ soloistPort: channel.soloistPort, appliancePid: channel.appliancePid, applianceStartedAt: channel.applianceStartedAt });
          stage = 'owned-snapshot';
          const snapshot = await readStartupFresh();
          if (!snapshotValid(snapshot, now(), maximumFreshAgeMs)) throw fail('DISCOVERY_IDENTITY_CHANGED');
          state.deviceID = snapshot.zeroConf.deviceID;
          stage = 'owned-recheck';
          await trusted(state.channel, state.deviceID, controller.signal, readStartupFresh);
          stage = 'relay-get-info'; attempt = 0;
          const info = await transfer(state.channel, { method: 'GET', path: '/zc?action=getInfo' }, Buffer.alloc(0), controller.signal);
          try {
            if (info.status !== 200) throw fail('DISCOVERY_UNAVAILABLE');
            publicInfo(info.bytes, state.deviceID, deviceName);
          } finally { info.bytes.fill(0); }
          stage = 'interfaces';
          const lan = addresses(networkInterfaces());
          if (!lan.length) throw fail('DISCOVERY_INTERFACE_UNAVAILABLE');
          const allowed = new Set(['127.0.0.1', '::1', ...lan]);
          stage = 'host-listen';
          const server = createServer(async (request, response) => {
            const deny = status => { response.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }); response.end(); request.resume(); };
            if (closed || !allowed.has(normalizeAddress(request.socket.remoteAddress))) { deny(403); return; }
            if (activeRequests.size >= 8) { deny(503); return; }
            const control = new AbortController(); activeRequests.add(control);
            const abort = () => control.abort(); lifetime.signal.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(abort, timeoutMs);
            const disconnect = () => { if (!response.writableEnded) abort(); };
            response.on('close', disconnect); request.on('aborted', abort);
            let body, result, action;
            try {
              const declared = request.headers['content-length'];
              if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBodyBytes)) { deny(413); return; }
              // Reject paths/methods before accepting even a bounded credential body.
              if (!/^\/zc(?:\?|$)/.test(request.url || '') || !['GET', 'POST'].includes(request.method)) { deny(404); return; }
              body = await abortable((async () => {
                const chunks = []; let size = 0;
                try {
                  for await (const chunk of request) {
                    size += chunk.length;
                    if (size > maximumBodyBytes) throw fail('REQUEST_TOO_LARGE');
                    chunks.push(Buffer.from(chunk));
                  }
                  return Buffer.concat(chunks, size);
                } finally { for (const chunk of chunks) chunk.fill(0); }
              })(), control.signal);
              const target = pairingRequest(request, body); action = target.action;
              // Anonymous discovery uses the fixed relay proved at startup;
              // the guest still proves the SDK listener for every request.
              // Pairing checks the local lease; the guest proves the actual SDK
              // before and after forwarding, without a duplicate host SSH read.
              if (target.method === 'POST') await verifyCurrentChannel(state.channel, control.signal);
              result = await transfer(state.channel, target, body, control.signal);
              if (target.method === 'POST') await verifyCurrentChannel(state.channel, control.signal);
              // Never follow redirects or expose a replacement local daemon.
              if (result.status >= 300 && result.status < 400) throw fail('DISCOVERY_PROTOCOL_INVALID');
              if (action === 'getInfo' && result.status === 200) publicInfo(result.bytes, state.deviceID, deviceName);
              if (control.signal.aborted || closed) throw fail('CANCELLED');
              response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': result.bytes.length,
                'cache-control': 'no-store', connection: 'close' });
              // Node may queue the original buffer; wipe it only after the socket
              // has consumed it, otherwise pairing replies can become zero bytes.
              await abortable(new Promise(resolve => response.end(result.bytes, resolve)), control.signal);
              report({ event: 'pairing-request', action, status: result.status });
            } catch (error) {
              if (!response.headersSent && !response.destroyed) deny(error?.code === 'REQUEST_TOO_LARGE' ? 413
                : error?.code === 'REQUEST_NOT_ALLOWED' ? 400 : error?.code === 'CANCELLED' ? 504 : 502);
              if (error?.code === 'DISCOVERY_IDENTITY_CHANGED') void close();
              report({ event: 'pairing-rejected', action: action || 'unsupported', code: ['REQUEST_TOO_LARGE', 'REQUEST_NOT_ALLOWED', 'DISCOVERY_IDENTITY_CHANGED', 'CANCELLED'].includes(error?.code) ? error.code : 'DISCOVERY_UNAVAILABLE' });
            } finally {
              clearTimeout(timer); activeRequests.delete(control); lifetime.signal.removeEventListener('abort', abort);
              response.removeListener('close', disconnect); request.removeListener('aborted', abort);
              body?.fill(0); result?.bytes.fill(0);
            }
          });
          state.servers.push(server); server.requestTimeout = timeoutMs; server.headersTimeout = timeoutMs; server.keepAliveTimeout = 1;
          server.on('connection', socket => { state.sockets.add(socket); socket.on('close', () => state.sockets.delete(socket)); });
          server.on('clientError', (_error, socket) => socket.destroy());
          server.on('error', () => { if (state.ready) { report({ event: 'discovery-error', code: 'DISCOVERY_UNAVAILABLE' }); void close(); } });
          await abortable(new Promise((resolve, reject) => {
            const failed = () => { server.removeListener('listening', ready); reject(fail('DISCOVERY_UNAVAILABLE')); };
            const ready = () => { server.removeListener('error', failed); resolve(); };
            server.once('error', failed); server.once('listening', ready); server.listen({ host: '0.0.0.0', port: 0, exclusive: true });
          }), controller.signal);
          const bridgePort = server.address().port;
          const tag = createHash('sha256').update(state.deviceID).digest('hex').slice(0, 24);
          const service = `folia-${tag}.${TYPE}`, host = `folia-soloist-${tag}.local`;
          const records = ttl => [{ name: TYPE, type: 'PTR', ttl, data: service },
            { name: '_services._dns-sd._udp.local', type: 'PTR', ttl, data: TYPE },
            { name: service, type: 'SRV', ttl, flush: true, data: { port: bridgePort, priority: 0, weight: 0, target: host } },
            { name: service, type: 'TXT', ttl, flush: true, data: [Buffer.from('CPath=/zc'), Buffer.from('VERSION=1.0'), Buffer.from('Stack=SP')] },
            ...lan.map(address => ({ name: host, type: 'A', ttl, flush: true, data: address }))];
          state.records = records;
          for (const address of lan) {
            stage = 'mdns-ready';
            const mdns = createMdns({ interface: address, bind: '0.0.0.0', type: 'udp4', reuseAddr: true, loopback: true, ttl: 255 });
            state.publishers.push(mdns);
            mdns.on('error', () => { report({ event: 'discovery-error', code: 'DISCOVERY_UNAVAILABLE' }); void close(); });
            // Parse warnings can be caused by unrelated malformed LAN packets.
            // They are intentionally not logged and cannot crash the main process.
            mdns.on('warning', error => {
              if (['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENETUNREACH', 'ENODEV', 'EINVAL'].includes(error?.code)) {
                mdns.emit('error', fail('DISCOVERY_UNAVAILABLE'));
              }
            });
            await abortable(new Promise((resolve, reject) => {
              const failed = () => { mdns.removeListener('ready', ready); reject(fail('DISCOVERY_UNAVAILABLE')); };
              const ready = () => { mdns.removeListener('error', failed); resolve(); };
              mdns.once('error', failed); mdns.once('ready', ready);
            }), controller.signal);
            const publish = () => new Promise((resolve, reject) => {
              mdns.respond({ answers: records(120) }, error => error ? reject(fail('DISCOVERY_UNAVAILABLE')) : resolve());
            });
            mdns.on('query', packet => {
              if (closed || !Array.isArray(packet?.questions) || packet.questions.length > 32) return;
              if (!packet.questions.some(question => [TYPE, service, host, '_services._dns-sd._udp.local'].includes(String(question.name).replace(/\.$/, '').toLowerCase()))) return;
              // One reply per interface per 100ms avoids query amplification.
              if (now() - (mdns.lastReply || 0) < 100) return; mdns.lastReply = now();
              void publish().catch(() => { report({ event: 'discovery-error', code: 'DISCOVERY_UNAVAILABLE' }); void close(); });
            });
            stage = 'mdns-publish';
            await abortable(publish(), controller.signal); state.published = true;
            for (const delay of [1000, 3000]) state.timers.push(setTimeout(() => { if (!closed) void publish().catch(() => void close()); }, delay));
            const renewal = setInterval(() => { if (!closed) void publish().catch(() => void close()); }, 60000); renewal.unref?.(); state.timers.push(renewal);
          }
          if (closed || controller.signal.aborted) throw fail('CANCELLED');
          state.ready = true;
          state.result = Object.freeze({ available: true, sameHostOnly: true, port: bridgePort, interfaces: Object.freeze([...lan]), deviceName });
          report({ event: 'discovery-started', phase: 'result', stage: 'ready', ok: true, interfaces: lan.length }); return state.result;
        } catch (error) {
          const readinessTimeout = timedOut && readinessCause === 'SOLOIST_STARTING' && !signal?.aborted && !lifetime.signal.aborted;
          const code = readinessTimeout ? 'SOLOIST_START_TIMEOUT'
            : ['CANCELLED', 'DISCOVERY_IDENTITY_CHANGED', 'DISCOVERY_INTERFACE_UNAVAILABLE'].includes(error?.code) ? error.code : 'DISCOVERY_UNAVAILABLE';
          report({ event: 'discovery-failed', phase: 'result', stage, ok: false, errorCode: code,
            causeCode: readinessTimeout ? readinessCause : sourceErrorCode(error), attempt });
          await close(); throw fail(code);
        } finally {
          clearTimeout(timer); lifetime.signal.removeEventListener('abort', cancel); signal?.removeEventListener('abort', cancel);
        }
      })();
    }
    return signal ? abortable(starting, signal) : starting;
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true; lifetime.abort(); for (const request of activeRequests) request.abort();
    closePromise = (async () => {
      const state = current;
      if (!state) return;
      for (const timer of state.timers) clearTimeout(timer);
      for (const socket of state.sockets) socket.destroy();
      await Promise.allSettled(state.servers.map(server => new Promise(resolve => { try { server.close(resolve); } catch { resolve(); } })));
      await Promise.allSettled(state.publishers.map(mdns => new Promise(resolve => {
        let done = false; const timer = setTimeout(finish, 250);
        function finish() { if (done) return; done = true; clearTimeout(timer); try { mdns.destroy(resolve); } catch { resolve(); } }
        try { if (state.published) mdns.respond({ answers: state.records(0) }, finish); else finish(); } catch { finish(); }
      })));
      report({ event: 'discovery-closed' });
    })();
    return closePromise;
  }
  return Object.freeze({ start, close, status: () => Object.freeze({ available: !closed && Boolean(current?.ready), closed }) });
}
module.exports = { createSoloistDiscovery };
