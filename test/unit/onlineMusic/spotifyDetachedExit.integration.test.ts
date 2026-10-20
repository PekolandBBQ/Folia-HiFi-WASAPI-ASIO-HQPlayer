import { afterEach, expect, it, vi } from 'vitest';
import { audioFixture, deferred, tick, trackId } from './ownedRouteFixture';

// Real controller/PCM/route orchestration; only source responses and native receipts are synthetic.
const fixtures: ReturnType<typeof audioFixture>[] = [];
async function detachedFixture({ processCapture = true, writesStarted = false, receipt = true } = {}) {
    const diagnostics: any[] = [];
    const f = audioFixture({ processCaptureProviderExit: processCapture, onDiagnostic: (value: any) => diagnostics.push(value) });
    fixtures.push(f);
    const prepared = await f.prepare(), source = f.audio.lookup(prepared.url);
    const opened = await source.openReadable(), reader = opened.stream[Symbol.asyncIterator]();
    const first = reader.next(); await tick();
    f.captures.at(-1).queue.push(Buffer.from([1, 0, 0, 0, 2, 0, 0, 0])); await first;
    const original = f.host.request.getMockImplementation()!;
    f.host.request.mockImplementation(async (command: string, payload: any) => {
        try { return await original(command, payload); }
        catch (cause) {
            if (command !== 'release' || f.state.device.is_active) throw cause;
            const error = Object.assign(new Error('SOURCE_BROKER_FAILED'), { code: 'SOURCE_BROKER_FAILED', cause });
            if (receipt) Object.assign(error, { retryableCleanupReceipt: { ok: false, state: 'recoveryRequired', code: 'SOURCE_BROKER_FAILED',
                cleanupRetryable: true, restoreWritesStarted: writesStarted, lease: structuredClone(f.lease()) } });
            throw error;
        }
    });
    const verifyStopped = vi.fn(async () => { f.events.push('capture:verify-provider-exit');
        for (const capture of f.captures) await capture.stopVerified(); });
    Object.assign(f.captureHost, { verifyStopped });
    f.state.device.is_active = false;
    return { ...f, source, prepared, diagnostics, verifyStopped };
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

it('remote device takeover retires PCM and defers only the unstarted Spotify route restore', async () => {
    const f = await detachedFixture();
    await expect(f.audio.leaveProvider()).resolves.toMatchObject({ pendingRestore: true, released: false });
    expect(f.verifyStopped).toHaveBeenCalledOnce();
    expect(f.captures[0].stopVerified).toHaveBeenCalled();
    expect(f.audio.lookup(f.prepared.url)).toBeNull();
    expect(f.lease().state).not.toBe('restored');
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ phase: 'provider-exit-deferred', nativeCode: 'SOURCE_BROKER_FAILED',
        routeRestored: false, captureStopped: true }));
    expect(f.events).not.toContain('control:transfer');
    // No failed pause may be followed by a Play/transfer that steals the remote session.
    const commandCount = f.events.filter(value => value === 'control:play').length;
    await f.audio.leaveProvider();
    expect(f.events.filter(value => value === 'control:play')).toHaveLength(commandCount);
});
it('re-entry retries the retained native owner and creates a new session only after real restoration', async () => {
    const f = await detachedFixture(); await f.audio.leaveProvider();
    const previous = f.lease().session;
    await expect(f.audio.prepare(trackId, '23456789-1234-1234-1234-123456789abc')).rejects.toHaveProperty('code');
    expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(1);
    f.state.device.is_active = true; f.state.is_playing = false;
    await expect(f.audio.prepare(trackId, '34567890-1234-1234-1234-123456789abc')).resolves.toHaveProperty('url');
    expect(f.lease().session).not.toBe(previous);
    expect(f.events.filter(value => value === 'route:release')).toHaveLength(1);
    await expect(f.source.pause()).rejects.toHaveProperty('code');
});
it('an unconfirmed native capture stop remains blocking and can recover on the next exit attempt', async () => {
    const f = await detachedFixture();
    f.verifyStopped.mockRejectedValueOnce(Object.assign(new Error('CAPTURE_STOP_TIMEOUT'), { code: 'CAPTURE_STOP_TIMEOUT' }));
    await expect(f.audio.leaveProvider()).rejects.toHaveProperty('code', 'CAPTURE_STOP_TIMEOUT');
    expect(f.diagnostics.some(value => value.phase === 'provider-exit-deferred')).toBe(false);
    await expect(f.audio.leaveProvider()).resolves.toHaveProperty('pendingRestore', true);
});
it.each(['cancel', 'leave', 'supersede'])('a re-entry waiting for restoration cannot revive after %s', async action => {
    const f = await detachedFixture(); await f.audio.leaveProvider();
    const gate = deferred<void>(), original = f.host.request.getMockImplementation()!;
    f.host.request.mockImplementation(async (command: string, payload: any) => {
        if (command === 'release') await gate.promise;
        return original(command, payload);
    });
    const id = '23456789-1234-1234-1234-123456789abc';
    const pending = f.audio.prepare(trackId, id); void pending.catch(() => {});
    await tick();
    let next: Promise<any> | undefined;
    if (action === 'cancel') f.audio.cancel(id);
    else if (action === 'leave') next = f.audio.leaveProvider();
    else next = f.audio.prepare(trackId, '34567890-1234-1234-1234-123456789abc');
    if (next) void next.catch(() => {});
    f.state.device.is_active = true; f.state.is_playing = false; gate.resolve();
    await expect(pending).rejects.toHaveProperty('nativeCode', 'CANCELLED');
    if (next) await next;
    expect(f.events.filter(value => value === 'route:acquire')).toHaveLength(action === 'supersede' ? 2 : 1);
});
it.each([{ processCapture: false }])
('keeps legacy endpoint capture cleanup unchanged: %j', async options => {
    const f = await detachedFixture(options);
    await expect(f.audio.leaveProvider()).rejects.toHaveProperty('code', 'ROUTE_RESTORE_UNCONFIRMED');
    expect(f.verifyStopped).not.toHaveBeenCalled();
    expect(f.diagnostics.some(value => value.phase === 'provider-exit-deferred')).toBe(false);
});
it.each([{writesStarted:true},{receipt:false}])('retains uncertain Spotify restoration without owning another source: %j',async options=>{
    const f=await detachedFixture(options);
    expect(f.source.detachOutputForProviderExit()).toBe(false);
    await expect(f.audio.leaveProvider()).resolves.toMatchObject({pendingRestore:true,released:false});
    expect(f.source.detachOutputForProviderExit()).toBe(true);
    expect(f.diagnostics).toContainEqual(expect.objectContaining({phase:'provider-exit-deferred',restoreWritesStarted:null,captureStopped:true,routeRestored:false}));
    expect(f.lease().state).not.toBe('restored');
});
