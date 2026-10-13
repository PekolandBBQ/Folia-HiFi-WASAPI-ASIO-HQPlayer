import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/onlineMusic/soloistAudioPreparation.test.ts: official selection, revocation and no-file preparation.
const { createSoloistAudioPreparation } = createRequire(import.meta.url)('../../../electron/spotify/soloistAudioPreparation.cjs');
const { createSoloistBrowserSession } = createRequire(import.meta.url)('../../../electron/spotify/soloistBrowserSession.cjs');
const id = '3n3Ppam7vgaVa1iaRUc9Lp', requestId = '12345678-1234-1234-1234-123456789abc';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(options: any = {}) {
  let revision = 0, retryAt = 0, handle: any;
  const vault = { stamp: () => ({ epoch: 0, revision }), token: vi.fn(async () => 'private-test-token'),
    grantedScopes: vi.fn(async () => ({ scopes: options.scopes || ['user-read-playback-state', 'user-modify-playback-state'] })) };
  const association = { acquirePlaybackTarget: vi.fn(async () => ({ deviceId: 'verified-api-device', validUntil: Date.now() + 5000,
    stamp: vault.stamp() })) };
  const cooldown = { load: async () => retryAt, defer: vi.fn(async () => { retryAt = Date.now() + 60000; return retryAt; }) };
  const client = { prepare: vi.fn(async () => ({ positionMs: 0 })), play: vi.fn(async () => ({})), pause: vi.fn(async () => ({})),
    close: vi.fn(async () => ({})), seek: vi.fn(async (_session: string, positionMs: number) => ({ positionMs })),
    openReadable: vi.fn((_session: string, _options?: { signal?: AbortSignal }) => (async function* () { yield Buffer.alloc(8, 1); })()) };
  const media = { add: vi.fn(async (producer: any) => {
    handle = { url: 'http://127.0.0.1:12345/' + 'opaque-source', revoke: vi.fn(), producer };
    return handle;
  }), close: vi.fn(async () => {}) };
  const fetcher = vi.fn(async (url: string, init: any) => {
    if (options.fetcher) return options.fetcher(url, init);
    return new Response(init.method === 'PUT' ? null : JSON.stringify({ id, type: 'track', uri: `spotify:track:${id}`, duration_ms: 120000 }),
      { status: init.method === 'PUT' ? 204 : 200 });
  });
  const audio = createSoloistAudioPreparation({ client, vault, association, cooldown, fetcher, media, soloistApplyQuality: options.soloistApplyQuality });
  cleanups.push(() => audio.close());
  return { audio, client, vault, association, cooldown, media, fetcher, handle: () => handle, revokeGrant: () => { revision++; } };
}
it('selects the requested URI and uses validated catalog duration only after fresh owned SDK preparation succeeds', async () => {
  const f = fixture();
  const source = await f.audio.prepare(id, requestId, () => {}, 'lossless');
  const [url, init] = f.fetcher.mock.calls.find(([, values]) => values.method === 'PUT')!;
  expect(new URL(url).pathname).toBe('/v1/me/player/play');
  expect(new URL(url).searchParams.get('device_id')).toBe('verified-api-device');
  expect(JSON.parse(init.body)).toEqual({ uris: [`spotify:track:${id}`], position_ms: 0 });
  expect(init.headers.Authorization).toBe('Bearer private-test-token');
  expect(f.client.prepare).toHaveBeenCalledWith(expect.objectContaining({ trackId: id, durationMs: 120000, positionMs: 0, requestedQuality: 'lossless' }));
  expect(source).toMatchObject({ quality: null, actualQuality: null, requestedQuality: 'lossless', sessionBoundAudio: true,
    sourceInfo: { encodingVerified: false, codec: null, lossless: null }, preparedAudio: { representation: 's32le', bitDepth: 32 } });
  expect(JSON.stringify(source)).not.toContain('private-test-token');
  expect(f.client.play).not.toHaveBeenCalled(); // Source publication alone never starts an unread producer.
});

it('applies the requested producer configuration before selecting the next track and keeps actual quality unknown', async () => {
  const apply = vi.fn(async (quality: string) => ({ requestedQuality: quality, configurationApplied: true, sourceQuality: null }));
  const f = fixture({ soloistApplyQuality: apply });
  const source = await f.audio.prepare(id, requestId, () => {}, 'lossless');
  expect(apply).toHaveBeenCalledWith('lossless', { signal: expect.any(AbortSignal) });
  expect(apply.mock.invocationCallOrder[0]).toBeLessThan(f.association.acquirePlaybackTarget.mock.invocationCallOrder[0]);
  expect(source.actualQuality).toBeNull(); expect(source.sourceInfo.lossless).toBeNull();
});
it('does not select or publish audio when producer quality configuration is not confirmed', async () => {
  const f = fixture({ soloistApplyQuality: async () => ({ requestedQuality: 'standard', configurationApplied: true, sourceQuality: null }) });
  await expect(f.audio.prepare(id, requestId, () => {}, 'lossless')).rejects.toThrow('soloist-quality-unconfirmed');
  expect(f.association.acquirePlaybackTarget).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('requires both granted official scopes before challenge, network or playback mutation', async () => {
  const f = fixture({ scopes: ['user-read-playback-state'] });
  await expect(f.audio.prepare(id, requestId)).rejects.toMatchObject({ code: 'auth-required' });
  expect(f.association.acquirePlaybackTarget).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.client.prepare).not.toHaveBeenCalled();
});
it('does not publish a catalog/selected candidate as playback proof when the owned SDK rejects its current URI', async () => {
  const f = fixture();
  f.client.prepare.mockRejectedValueOnce(Object.assign(new Error('Spotify Soloist: TRACK_NOT_CURRENT'), { code: 'TRACK_NOT_CURRENT' }));
  await expect(f.audio.prepare(id, requestId)).rejects.toThrow('external-playback-change');
  expect(f.media.add).not.toHaveBeenCalled(); expect(f.client.pause).toHaveBeenCalledOnce(); expect(f.client.close).toHaveBeenCalledOnce();
});
it('does not poll stale Web player state after an acknowledged selection that the owned SDK confirms', async () => {
  const f = fixture({ fetcher: async (url: string, init: any) => {
    if (init.method === 'PUT') return new Response(null, { status: 204 });
    if (new URL(url).pathname === `/v1/tracks/${id}`) return Response.json({ id, uri: `spotify:track:${id}`, type: 'track', duration_ms: 120000 });
    return Response.json({ device: { id: 'old-api-device' }, item: { type: 'track', uri: `spotify:track:${'z'.repeat(22)}`, duration_ms: 200000 } });
  } });
  expect(await f.audio.prepare(id, requestId)).toMatchObject({ durationMs: 120000, streaming: true });
  expect(f.fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([`/v1/tracks/${id}`, '/v1/me/player/play']);
  expect(f.client.prepare).toHaveBeenCalledOnce(); expect(f.media.add).toHaveBeenCalledOnce();
});
it('uses only an explicit catalog relink to select and confirm the resolved SDK URI while keeping the user track identity', async () => {
  const linked = 'z'.repeat(22), f = fixture({ fetcher: async (_url: string, init: any) => init.method === 'PUT' ? new Response(null, { status: 204 }) : Response.json({
    id: linked, uri: `spotify:track:${linked}`, type: 'track', duration_ms: 119500,
    linked_from: { id, uri: `spotify:track:${id}`, type: 'track' },
  }) });
  const source = await f.audio.prepare(id, requestId);
  expect(f.client.prepare).toHaveBeenCalledWith(expect.objectContaining({ trackId: linked, durationMs: 119500 }));
  const put = f.fetcher.mock.calls.find(([, init]) => init.method === 'PUT')!;
  expect(JSON.parse(put[1].body)).toEqual({ uris: [`spotify:track:${linked}`], position_ms: 0 });
  expect(f.audio.lookup(source.url)).toMatchObject({ trackId: id, durationMs: 119500 });
});
it.each([{ id: 'z'.repeat(22) }, { uri: `spotify:track:${'z'.repeat(22)}` }, { type: 'episode' },
  { duration_ms: 0 }, { duration_ms: 3600001 }, { duration_ms: 1.5 }, { is_playable: false },
  { id: 'z'.repeat(22), uri: `spotify:track:${'z'.repeat(22)}`, linked_from: { id, uri: `spotify:track:${'x'.repeat(22)}`, type: 'track' } }])
('rejects invalid source metadata before any official selection: %o', async invalid => {
  const f = fixture({ fetcher: async () => Response.json({ id, uri: `spotify:track:${id}`, type: 'track', duration_ms: 120000, ...invalid }) });
  await expect(f.audio.prepare(id, requestId)).rejects.toHaveProperty('code');
  expect(f.fetcher.mock.calls.some(([, input]) => input.method === 'PUT')).toBe(false);
  expect(f.client.prepare).not.toHaveBeenCalled(); expect(f.media.add).not.toHaveBeenCalled();
});
it('releases an acknowledged official selection when fresh owned preparation fails instead of leaving an unregistered playing source', async () => {
  const f = fixture(); f.client.prepare.mockRejectedValueOnce(Object.assign(new Error('Spotify Soloist: CONTROL_FAILED'), { code: 'CONTROL_FAILED' }));
  await expect(f.audio.prepare(id, requestId)).rejects.toThrow('soloist-preparation-failed');
  expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
  expect(f.client.pause).toHaveBeenCalledOnce(); expect(f.client.close).toHaveBeenCalledOnce(); expect(f.media.add).not.toHaveBeenCalled();
});
it('a service-directed 429 is shared with the next request and never retries official control', async () => {
  const f = fixture({ fetcher: async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }) });
  await expect(f.audio.prepare(id, requestId)).rejects.toThrow('rate-limited');
  await expect(f.audio.prepare(id, '12345678-1234-1234-1234-123456789abd')).rejects.toThrow('rate-limited');
  expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.client.prepare).not.toHaveBeenCalled();
});
it('direct native PCM remains memory-only and paused seek requires a fresh confirmed producer origin', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  const native = f.audio.lookup(source.url); expect(f.audio.lookup(source.url + 'other')).toBeNull();
  const first = await native.openReadable({ positionMs: 0 });
  const bytes: Buffer[] = []; for await (const block of first.stream) bytes.push(block);
  expect(Buffer.concat(bytes)).toEqual(Buffer.alloc(8, 1)); expect(f.client.play).toHaveBeenCalledTimes(1);
  await native.pause(); const resumed = await native.openReadable({ positionMs: 10000 });
  expect(f.client.seek).toHaveBeenCalledWith(expect.any(String), 10000); expect(resumed.positionMs).toBe(10000);
  expect(f.media.add).toHaveBeenCalledTimes(1);
});
it('a cold output format handshake cannot start the unread bounded guest producer', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  const native = f.audio.lookup(source.url), ready = await native.openReadable({ positionMs: 0 });
  let finishHandshake!: () => void;
  const handshake = new Promise<void>(resolve => { finishHandshake = resolve; });
  const consumption = (async () => {
    await handshake;
    const bytes: Buffer[] = []; for await (const block of ready.stream) bytes.push(block);
    return Buffer.concat(bytes);
  })();
  await Promise.resolve();
  expect(f.client.openReadable).not.toHaveBeenCalled(); expect(f.client.play).not.toHaveBeenCalled();
  finishHandshake();
  expect(await consumption).toEqual(Buffer.alloc(8, 1)); expect(f.client.play).toHaveBeenCalledTimes(1);
});
it('a consumer cancelled during the cold format handshake never opens or starts the producer', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  const abort = new AbortController(), native = f.audio.lookup(source.url);
  const ready = await native.openReadable({ positionMs: 0, signal: abort.signal }); abort.abort();
  await expect(ready.stream[Symbol.asyncIterator]().next()).rejects.toThrow('request-cancelled');
  expect(f.client.openReadable).not.toHaveBeenCalled(); expect(f.client.play).not.toHaveBeenCalled();
  expect(f.audio.lookup(source.url)).not.toBeNull();
});
it('an official play failure aborts a waiting PCM read and revokes the unusable source', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  const failure = Object.assign(new Error('official-play-failed'), { code: 'CONTROL_REJECTED' });
  let readAborted = false;
  f.client.openReadable.mockImplementation((_session: string, options?: { signal?: AbortSignal }) => (async function* () {
    const signal = options!.signal!;
    await new Promise<void>(resolve => {
      const stop = () => { readAborted = true; resolve(); };
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    });
    throw Object.assign(new Error('read-cancelled'), { code: 'CANCELLED' });
  })());
  f.client.play.mockRejectedValueOnce(failure);
  const ready = await f.audio.lookup(source.url).openReadable();
  await expect(ready.stream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  expect(readAborted).toBe(true); expect(f.audio.lookup(source.url)).toBeNull(); expect(f.handle().revoke).toHaveBeenCalledTimes(1);
});
it('grant revocation prevents an already published native source from being opened', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId); const native = f.audio.lookup(source.url); f.revokeGrant();
  await expect(native.openReadable()).rejects.toThrow('session-changed'); expect(f.client.play).not.toHaveBeenCalled();
});
it('cancel after publication revokes the handle and owner-gated source without retaining a reusable URL', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  f.audio.cancel(requestId); await f.audio.clear();
  expect(f.audio.lookup(source.url)).toBeNull(); expect(f.handle().revoke).toHaveBeenCalledTimes(1);
  expect(f.client.pause).toHaveBeenCalledTimes(1); expect(f.client.close).toHaveBeenCalledTimes(1);
});
it('a late cancelled observation from a prior reader does not revoke the next seek generation', async () => {
  const f = fixture(); const source = await f.audio.prepare(id, requestId);
  let rejectOld!: (error: Error) => void;
  f.client.play.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const native = f.audio.lookup(source.url), old = await native.openReadable();
  const iterator = old.stream[Symbol.asyncIterator](); await iterator.next();
  await native.pause(); await native.openReadable({ positionMs: 10000 });
  rejectOld(Object.assign(new Error('old-observation'), { code: 'CANCELLED' })); await Promise.resolve();
  expect(f.audio.lookup(source.url)).not.toBeNull(); expect(f.handle().revoke).not.toHaveBeenCalled();
  await iterator.return?.();
});
it('browser to native to browser output handoff reads new PCM at each checkpoint from the one published source', async () => {
  const f = fixture(); let origin = 0;
  f.client.seek.mockImplementation(async (_session: string, positionMs: number) => { origin = positionMs; return { positionMs }; });
  f.client.openReadable.mockImplementation(() => {
    const sample = origin + 1;
    return (async function* () { const block = Buffer.alloc(8); block.writeInt32LE(sample, 0); block.writeInt32LE(-sample, 4); yield block; })();
  });
  const source = await f.audio.prepare(id, requestId), browser = createSoloistBrowserSession({ lookup: (url: string) => f.audio.lookup(url) });
  cleanups.push(() => browser.close());
  const firstSession = '22345678-1234-1234-1234-123456789abc', nextSession = '32345678-1234-1234-1234-123456789abc';
  await browser.request({ action: 'begin', session: firstSession, url: source.url });
  const first = await browser.request({ action: 'start', session: firstSession, positionMs: 0 });
  const initialBytes = await browser.request({ action: 'pull', session: firstSession, generation: first.generation });
  expect(Buffer.from(initialBytes.data).readInt32LE()).toBe(1);
  await browser.request({ action: 'pause', session: firstSession });
  await browser.request({ action: 'stop', session: firstSession });
  expect(f.audio.lookup(source.url)).not.toBeNull(); expect(f.client.close).not.toHaveBeenCalled();
  const native = f.audio.lookup(source.url), second = await native.openReadable({ positionMs: 5000 });
  expect(second.positionMs).toBe(5000);
  const nativeReader = second.stream[Symbol.asyncIterator](), nativeBytes = await nativeReader.next();
  expect(nativeBytes.value.readInt32LE()).toBe(5001); await native.pause(); await nativeReader.return?.();
  expect(f.audio.lookup(source.url)).not.toBeNull();
  await browser.request({ action: 'begin', session: nextSession, url: source.url });
  const last = await browser.request({ action: 'start', session: nextSession, positionMs: 7000 });
  const finalBytes = await browser.request({ action: 'pull', session: nextSession, generation: last.generation });
  expect(Buffer.from(finalBytes.data).readInt32LE()).toBe(7001); expect(last.positionMs).toBe(7000);
  expect(f.client.play).toHaveBeenCalledTimes(3); expect(f.client.seek.mock.calls.map(([, ms]) => ms)).toEqual([5000, 7000]);
  expect(f.media.add).toHaveBeenCalledTimes(1); expect(f.handle().revoke).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
  expect(f.client.close).not.toHaveBeenCalled(); await browser.close();
});
it('late cleanup from an outgoing output cannot pause or feed its replacement consumer', async () => {
  const f = fixture(); let running = false, origin = 0;
  f.client.play.mockImplementation(async () => { running = true; return {}; });
  f.client.pause.mockImplementation(async () => { running = false; return {}; });
  f.client.seek.mockImplementation(async (_session: string, positionMs: number) => { running = false; origin = positionMs; return { positionMs }; });
  f.client.openReadable.mockImplementation(() => {
    const at = origin;
    return (async function* () {
      for (const sample of [at + 1, at + 2]) {
        if (!running) throw new Error('producer-was-paused');
        const block = Buffer.alloc(8); block.writeInt32LE(sample, 0); block.writeInt32LE(-sample, 4); yield block;
      }
    })();
  });
  const source = await f.audio.prepare(id, requestId), outgoing = f.audio.lookup(source.url), neverStarted = f.audio.lookup(source.url);
  const first = await outgoing.openReadable(), oldReader = first.stream[Symbol.asyncIterator]();
  expect((await oldReader.next()).value.readInt32LE()).toBe(1);
  const incoming = f.audio.lookup(source.url), second = await incoming.openReadable({ positionMs: 12000 });
  const nextReader = second.stream[Symbol.asyncIterator](); expect((await nextReader.next()).value.readInt32LE()).toBe(12001);
  const pauseCalls = f.client.pause.mock.calls.length;
  await outgoing.stop(); await outgoing.pause(); await neverStarted.stop();
  expect(f.client.pause).toHaveBeenCalledTimes(pauseCalls);
  expect((await nextReader.next()).value.readInt32LE()).toBe(12002);
  await expect(oldReader.next()).rejects.toThrow('request-cancelled');
  await expect(outgoing.openReadable({ positionMs: 5000 })).rejects.toThrow('request-cancelled');
  await expect(neverStarted.openReadable({ positionMs: 5000 })).rejects.toThrow('request-cancelled');
  expect(f.handle().revoke).not.toHaveBeenCalled(); expect(f.audio.lookup(source.url)).not.toBeNull();
  await nextReader.return?.();
});
