import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/desktopPlaybackApi.test.ts: real request-layer response handling with synthetic transport only.
const { createDesktopPlaybackApi } = createRequire(import.meta.url)('../../../electron/spotify/desktopPlaybackApi.cjs');
const { installPreviewDiagnosticSink } = createRequire(import.meta.url)('../../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { projectEvent } = createRequire(import.meta.url)('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const commands = ['transfer', 'select', 'play', 'pause', 'seek', 'volume'];

function fixture(status = 200, timeoutMs = 4000) {
  let revision = 0, retryAt = 0;
  const vault = { token: vi.fn(async () => 'synthetic-token'), stamp: () => ({ epoch: 0, revision }),
    grantedScopes: vi.fn(async () => ({ epoch: 0, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] })) };
  const cooldown = { load: vi.fn(async () => retryAt), defer: vi.fn(async (_value: string) => { retryAt = 61000; return retryAt; }) };
  const fetcher = vi.fn(async (_url: string, _init: any) => new Response(null, { status }));
  const record = { deviceId: 'desktop-1', trackId: '3n3Ppam7vgaVa1iaRUc9Lp', stamp: vault.stamp(),
    controller: new AbortController(), mutationPending: false };
  const current = vi.fn(() => {
    if (record.controller.signal.aborted) throw Object.assign(new Error('STALE_SESSION'), { code: 'STALE_SESSION' });
  });
  const api = createDesktopPlaybackApi({ vault, cooldown, fetcher, now: () => 1000, timeoutMs });
  return { api, vault, cooldown, fetcher, record, current,
    request: (operation = 'pause', options: any = {}) => api.request(operation, record, current, { positionMs: 0, volumePercent: 0, ...options }),
    changeGrant: () => { revision++; } };
}

it.each([200, 204])('accepts pause HTTP %s as acknowledgment without certifying playback state', async status => {
  const f = fixture(status);
  await expect(f.request()).resolves.toEqual(status === 200 ? { acknowledgment: 'UNCONFIRMED' } : null);
  expect(f.record.mutationPending).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
  const [address, init] = f.fetcher.mock.calls[0];
  expect(address).toBe('https://api.spotify.com/v1/me/player/pause?device_id=desktop-1');
  expect(init).toMatchObject({ method: 'PUT', cache: 'no-store', redirect: 'error' });
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

it.each([0, 42, 100])('sends only the exact device and valid volume %s to the official endpoint', async volumePercent => {
  const f = fixture(204); await f.request('volume', { volumePercent });
  expect(f.fetcher.mock.calls[0][0]).toBe(`https://api.spotify.com/v1/me/player/volume?device_id=desktop-1&volume_percent=${volumePercent}`);
  expect(f.fetcher.mock.calls[0][1].body).toBeUndefined();
});

it.each([-1, 101, 0.5, null, undefined, '0'])('rejects invalid volume before any request: %j', async volumePercent => {
  const f = fixture(); await expect(f.request('volume', { volumePercent })).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(['', ' \t\r\n', 'null', '{}', ' { \n } \t', ' '.repeat(4096)])('keeps bounded inert pause HTTP 200 bodies unconfirmed: %j', async body => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  expect(f.record.mutationPending).toBe(true);
});

it.each([
  '{"error":{"status":403,"message":"private error"}}', '{"error":null}', '{"ok":true}',
  '{"is_playing":false}', '[]', 'false', '0', '""', '\uFEFF{}', '\u00A0', 'bad\u0000text', 'bad\u0085text',
  ' '.repeat(4097), new Uint8Array([0xff]),
])('rejects error, unknown, malformed or oversized pause HTTP 200 body case %#', async body => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body));
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.record.mutationPending).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(['Synthetic plain reply', 'Operation unavailable in this synthetic fixture', '{', '{} trailing', 'null trailing', '123 trailing', '<html>synthetic</html>'])('leaves opaque pause 200 unconfirmed without trusting its wording: %s', async body => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  expect(f.record.mutationPending).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(['application/json', 'text/html', 'application/octet-stream'])('does not infer success or rejection from an unknown body content type: %s', async contentType => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response('Synthetic plain reply', { headers: { 'content-type': contentType } }));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
});

it('bounds a stalled pause acknowledgment body and does not await a stalled producer cancellation', async () => {
  const f = fixture(200, 5), cancel = vi.fn(() => new Promise<void>(() => {}));
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(' ')); }, cancel,
  })));
  await expect(f.request()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.record.mutationPending).toBe(true);
});

it.each(['caller', 'lease', 'grant'])('invalidates pause acknowledgment during the body drain after %s changes', async source => {
  const f = fixture(), abort = new AbortController(); let pulls = 0;
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
    if (++pulls === 1) { controller.enqueue(new TextEncoder().encode(' ')); return; }
    if (source === 'caller') abort.abort();
    else if (source === 'lease') f.record.controller.abort();
    else f.changeGrant();
    controller.close();
  } })));
  await expect(f.request('pause', { signal: abort.signal })).rejects.toMatchObject({ code:
    source === 'caller' ? 'CANCELLED' : source === 'lease' ? 'STALE_SESSION' : 'SESSION_CHANGED' });
  expect(f.record.mutationPending).toBe(true);
});

it('rejects a truncated pause acknowledgment body and retains the uncertain mutation', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{')); controller.error(new TypeError('private transport detail'));
  } })));
  await expect(f.request()).rejects.toBeInstanceOf(TypeError);
  expect(f.record.mutationPending).toBe(true);
});

it.each(commands)('preserves documented HTTP 204 acknowledgment for %s', async operation => {
  const f = fixture(204);
  await expect(f.request(operation)).resolves.toBeNull();
  expect(f.record.mutationPending).toBe(true);
});

it.each(commands)('keeps undocumented HTTP 200 unconfirmed for %s', async operation => {
  const f = fixture(200);
  await expect(f.request(operation)).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  expect(f.record.mutationPending).toBe(true);
});

it.each([201, 202, 203, 205, 206, 299])('rejects unexpected successful pause HTTP %s without assuming the command settled', async status => {
  const f = fixture(status);
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.record.mutationPending).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each([
  [300, 'API_UNAVAILABLE', true], [400, 'API_UNAVAILABLE', true], [401, 'AUTH_REQUIRED', false],
  [403, 'API_FORBIDDEN', false], [404, 'PLAYBACK_UNAVAILABLE', false], [409, 'API_UNAVAILABLE', true],
  [500, 'API_UNAVAILABLE', true], [503, 'API_UNAVAILABLE', true],
])('preserves HTTP %s error classification and pending-mutation semantics', async (status, code, pending) => {
  const f = fixture(status as number);
  f.fetcher.mockResolvedValue(new Response('private upstream error', { status: status as number }));
  await expect(f.request()).rejects.toMatchObject({ code, message: code });
  expect(f.record.mutationPending).toBe(pending);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('honors Retry-After and blocks subsequent requests through the shared cooldown', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
  await expect(f.request()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: 61000 });
  expect(f.record.mutationPending).toBe(false);
  expect(f.cooldown.defer).toHaveBeenCalledWith('60');
  await expect(f.request()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: 61000 });
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(['caller', 'lease', 'grant'])('rejects a late pause HTTP 200 acknowledgment after %s invalidation', async source => {
  const f = fixture(), abort = new AbortController();
  f.fetcher.mockImplementation(async (_url, init) => {
    if (source === 'caller') abort.abort();
    else if (source === 'lease') f.record.controller.abort();
    else f.changeGrant();
    expect(init.signal.aborted).toBe(source !== 'grant');
    return new Response(null, { status: 200 });
  });
  await expect(f.request('pause', { signal: abort.signal })).rejects.toMatchObject({ code:
    source === 'caller' ? 'CANCELLED' : source === 'lease' ? 'STALE_SESSION' : 'SESSION_CHANGED' });
  expect(f.record.mutationPending).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('does not dispatch pause when the caller already cancelled', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await expect(f.request('pause', { signal: abort.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.record.mutationPending).toBe(false);
});

it('cancels a pending transport through its bounded timeout without replaying the mutation', async () => {
  const f = fixture(200, 5);
  f.fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  await expect(f.request()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(f.record.mutationPending).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('keeps authorization scope and session checks ahead of playback commands', async () => {
  const f = fixture();
  f.vault.grantedScopes.mockResolvedValue({ epoch: 0, revision: 0, scopes: ['user-read-playback-state'] });
  await expect(f.api.authorize(f.current)).rejects.toMatchObject({ code: 'SCOPE_REQUIRED' });
  expect(f.fetcher).not.toHaveBeenCalled();
  f.changeGrant();
  await expect(f.request()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('preserves fresh GET JSON parsing and the separate empty-state response', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json({ is_playing: false }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response('invalid JSON', { status: 200 }));
  await expect(f.request('state')).resolves.toEqual({ is_playing: false });
  await expect(f.request('state')).resolves.toBeNull();
  await expect(f.request('state')).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.record.mutationPending).toBe(false);
});

it('bounds a stalled GET body and its producer cancellation with the request signal', async () => {
  const f = fixture(200, 5), cancel = vi.fn(() => new Promise<void>(() => {}));
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel,
  })));
  await expect(f.request('state')).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancel).toHaveBeenCalledOnce(); expect(f.record.mutationPending).toBe(false);
});

it('records only an unconfirmed phase for a plain-text 200, without exposing its contents', async () => {
  const events: any[] = [], detach = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { events.push({ type, fields }); return true; } });
  try {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('PRIVATE_SYNTHETIC_ACK'));
    await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
    expect(events.filter(row => row.type === 'spotify.playback-control').map(row => row.fields)).toEqual([
      { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'unconfirmed', bodyShape: 'plain-text', bodyBytes: 21,
        contentType: 'text', contentEncoding: 'missing' },
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SYNTHETIC_ACK');
  } finally { detach(); }
});

it('records acknowledgment shape and exact control failure context without raw bodies or identity', async () => {
  const events: any[] = [];
  const detach = installPreviewDiagnosticSink({ enabled: () => true,
    record: (type: string, fields: any) => { events.push({ type, fields }); return true; } });
  try {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{"error":"PRIVATE_RESPONSE"}'));
    await f.request();
    await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
    expect(events.filter(row => row.type === 'spotify.playback-control').map(row => row.fields)).toEqual([
      { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'unconfirmed', bodyShape: 'empty-object', bodyBytes: 2,
        contentType: 'text', contentEncoding: 'missing' },
      { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'failed', errorCode: 'PROTOCOL_INVALID',
        bodyShape: 'error-json', bodyBytes: 28, contentType: 'text', contentEncoding: 'missing' },
    ]);
    expect(events.filter(row => row.type === 'spotify.http')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_RESPONSE|synthetic-token|desktop-1|spotify\.com|3n3Ppam/);
  } finally { detach(); }
});

it('projects only bounded allowlisted acknowledgment diagnostics', () => {
  const fields = { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'failed' };
  expect(projectEvent('spotify.playback-control', { ...fields, bodyShape: 'PRIVATE_BODY', bodyBytes: 4098,
    errorCode: 'PRIVATE_ERROR', url: 'PRIVATE_URL', token: 'PRIVATE_TOKEN', body: 'PRIVATE_BODY' })).toEqual({
    type: 'spotify.playback-control', fields,
  });
  expect(projectEvent('spotify.playback-control', { ...fields, endpoint: 'PRIVATE_ENDPOINT' })).toBeNull();
  expect(projectEvent('spotify.playback-control', { ...fields, httpStatus: 700 })).toBeNull();
});

it.each(commands.flatMap(operation => ['', 'null', '{}', '123 opaque text', '{', '<html>opaque</html>']
  .map(body => ({ operation, body }))))('classifies all eligible $operation 200 bodies as unconfirmed: $body', async ({ operation, body }) => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }));
  await expect(f.request(operation)).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  expect(f.record.mutationPending).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(commands.flatMap(operation => ['{"error":null}', '{"success":true}', '[]', '123', 'true', '"ok"', '\uFEFFok',
  'bad\u0000text', 'bad\u0085text', new Uint8Array([0xff]), ' '.repeat(4097)]
  .map(body => ({ operation, body }))))('rejects unsafe or structured $operation 200 case %#', async ({ operation, body }) => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body));
  await expect(f.request(operation)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  expect(f.record.mutationPending).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(commands)('bounds a stalled $s fetch even when it ignores AbortSignal', async operation => {
  const f = fixture(200, 5); f.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
  await expect(f.request(operation)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.record.mutationPending).toBe(true);
});

it.each(commands)('bounds a stalled %s response read and cancellation', async operation => {
  const f = fixture(200, 5), cancel = vi.fn(() => new Promise<void>(() => {}));
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('opaque')); }, cancel,
  })));
  await expect(f.request(operation)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancel).toHaveBeenCalledOnce(); expect(f.record.mutationPending).toBe(true);
});

it.each(commands)('rejects incomplete %s response bodies', async operation => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('opaque')); controller.error(new TypeError('private transport detail'));
  } })));
  await expect(f.request(operation)).rejects.toBeInstanceOf(TypeError);
  expect(f.record.mutationPending).toBe(true);
});

it.each(commands.flatMap(operation => ['caller', 'lease', 'grant'].map(source => ({ operation, source }))))(
  'invalidates %s during its response drain', async ({ operation, source }) => {
    const f = fixture(), abort = new AbortController(); let pulls = 0;
    f.fetcher.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
      if (++pulls === 1) { controller.enqueue(new TextEncoder().encode('opaque')); return; }
      if (source === 'caller') abort.abort(); else if (source === 'lease') f.record.controller.abort(); else f.changeGrant();
      controller.close();
    } })));
    await expect(f.request(operation, { signal: abort.signal })).rejects.toMatchObject({ code:
      source === 'caller' ? 'CANCELLED' : source === 'lease' ? 'STALE_SESSION' : 'SESSION_CHANGED' });
    expect(f.record.mutationPending).toBe(true);
  });

it('does not equate state HTTP 200 JSON null with the explicit empty-player HTTP 204', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response('null')).mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(f.request('state')).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  await expect(f.request('state')).resolves.toBeNull();
});
