import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';

// test/unit/onlineMusic/soloistRuntime.test.ts: optional main-only construction and single control/client lifecycle.
const { createSoloistRuntime } = createRequire(import.meta.url)('../../../electron/spotify/soloistRuntime.cjs');
const keyPath = path.join(os.tmpdir(), 'isolated-user', 'soloist', 'id');
const knownHostsPath = path.join(os.tmpdir(), 'isolated-user', 'soloist', 'hosts');
const sshExecutablePath = path.join(os.tmpdir(), 'isolated-user', 'runtime', 'ssh.exe');
function fixture(configuration: any = {}) {
    const owner = { readFresh: vi.fn(), seekOwnedPaused: vi.fn() }, applyQuality = vi.fn();
    const configurationValue = { ownedSoloist: owner, keyPath, knownHostsPath, deviceName: 'Owned Test Device', applyQuality, ...configuration };
    const invoke = Object.assign(vi.fn(), { dispose: vi.fn() });
    const bootstrap = vi.fn(), createBootstrap = vi.fn(() => bootstrap), createInvoker = vi.fn(() => invoke);
    const clients: any[] = [], createClient = vi.fn(() => { const value = { prepare: vi.fn(async () => ({})),
        openReadable: vi.fn(() => (async function* () { yield Buffer.alloc(8, 1); })()), dispose: vi.fn() }; clients.push(value); return value; });
    const runtime = createSoloistRuntime({ configuration: configurationValue, createBootstrap, createInvoker, createClient });
    return { runtime, owner, applyQuality, invoke, clients, createBootstrap, createInvoker, createClient };
}
it('missing configuration retains the legacy service without creating a client, bootstrap or VM', async () => {
    const createBootstrap = vi.fn(), createInvoker = vi.fn(), createClient = vi.fn();
    const runtime = createSoloistRuntime({ createBootstrap, createInvoker, createClient });
    expect(runtime.getServiceOptions()).toEqual({}); expect(runtime.getServiceOptions()).toEqual({});
    await runtime.close(); expect(createBootstrap).not.toHaveBeenCalled(); expect(createInvoker).not.toHaveBeenCalled(); expect(createClient).not.toHaveBeenCalled();
});
it('repeated service factory calls share one main client and do not dispatch SSH or ownership commands', async () => {
    const f = fixture(); const first = f.runtime.getServiceOptions(), second = f.runtime.getServiceOptions();
    expect(second.soloistPcmClient).toBe(first.soloistPcmClient); expect(second.ownedSoloist).toBe(f.owner);
    expect(second.soloistApplyQuality).toBe(f.applyQuality); expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.createBootstrap).toHaveBeenCalledWith({ keyPath, knownHostsPath });
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.owner.readFresh).not.toHaveBeenCalled(); await f.runtime.close();
});
it('a client-setting replacement retires its client and reuses the single control runtime without recreating an appliance', async () => {
    const f = fixture(); const first = f.runtime.getServiceOptions(); first.soloistPcmClient.dispose(); first.soloistPcmClient.dispose();
    const next = f.runtime.getServiceOptions(); expect(next.soloistPcmClient).not.toBe(first.soloistPcmClient);
    expect(f.clients[0].dispose).toHaveBeenCalledTimes(1); expect(f.createClient).toHaveBeenCalledTimes(2);
    expect(f.createBootstrap).toHaveBeenCalledTimes(1); expect(f.createInvoker).toHaveBeenCalledTimes(1); await f.runtime.close();
});
it('shares main-owned clean appliance ports between SSH bootstrap, private HTTP and the PCM reader', async () => {
    const f = fixture({ sshPort: 33991, pcmPort: 33992, user: 'folia' });
    f.runtime.getServiceOptions();
    expect(f.createBootstrap).toHaveBeenCalledWith({ keyPath, knownHostsPath,
        sshPort: 33991, pcmPort: 33992, user: 'folia' });
    expect(f.createInvoker).toHaveBeenCalledWith(expect.objectContaining({ pcmPort: 33992 }));
    expect(f.createClient).toHaveBeenCalledWith(expect.objectContaining({ port: 33992 }));
    expect(f.owner.readFresh).not.toHaveBeenCalled(); await f.runtime.close();
});
const dynamicChannel = () => ({ keyPath, knownHostsPath,
    sshPort: 33991, pcmPort: 33992, user: 'folia', sshExecutablePath });
it('catalog construction and an unconsumed lazy PCM reader perform no owner, bootstrap or client work', async () => {
    const resolveControlConfiguration = vi.fn(async () => dynamicChannel());
    const f = fixture({ keyPath: undefined, knownHostsPath: undefined, resolveControlConfiguration });
    const first = f.runtime.getServiceOptions(), second = f.runtime.getServiceOptions();
    expect(second.soloistPcmClient).toBe(first.soloistPcmClient);
    first.soloistPcmClient.openReadable('unstarted');
    expect(resolveControlConfiguration).not.toHaveBeenCalled(); expect(f.createBootstrap).not.toHaveBeenCalled();
    expect(f.createInvoker).not.toHaveBeenCalled(); expect(f.createClient).not.toHaveBeenCalled();
    await f.runtime.close(); expect(resolveControlConfiguration).not.toHaveBeenCalled();
});
it('concurrent first playback waits for one owner readiness gate and creates one private channel/client after it resolves', async () => {
    let ready!: (value: ReturnType<typeof dynamicChannel>) => void;
    const resolveControlConfiguration = vi.fn((_options: { signal: AbortSignal }) => new Promise(resolve => { ready = resolve; }));
    const f = fixture({ resolveControlConfiguration }), facade = f.runtime.getServiceOptions().soloistPcmClient;
    const first = facade.prepare({ session: 'first' }), second = facade.prepare({ session: 'second' });
    await vi.waitFor(() => expect(resolveControlConfiguration).toHaveBeenCalledOnce());
    expect(resolveControlConfiguration.mock.calls[0][0]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(f.createBootstrap).not.toHaveBeenCalled(); expect(f.createClient).not.toHaveBeenCalled();
    ready(dynamicChannel()); await Promise.all([first, second]);
    expect(f.createBootstrap).toHaveBeenCalledOnce(); expect(f.createInvoker).toHaveBeenCalledOnce(); expect(f.createClient).toHaveBeenCalledOnce();
    expect(f.createBootstrap).toHaveBeenCalledWith(expect.objectContaining({ executable: sshExecutablePath }));
    expect(f.clients[0].prepare).toHaveBeenCalledTimes(2);
    const reader = facade.openReadable('ready')[Symbol.asyncIterator]();
    expect((await reader.next()).value).toEqual(Buffer.alloc(8, 1)); await reader.return?.();
    await f.runtime.close(); expect(f.clients[0].dispose).toHaveBeenCalledOnce();
});
it('quit cancels a pending owner readiness gate and cannot create an instance from its late result', async () => {
    let ready!: (value: ReturnType<typeof dynamicChannel>) => void, receivedSignal!: AbortSignal;
    const f = fixture({ resolveControlConfiguration: ({ signal }: { signal: AbortSignal }) => {
        receivedSignal = signal; return new Promise(resolve => { ready = resolve; });
    } });
    const pending = f.runtime.getServiceOptions().soloistPcmClient.prepare({ session: 'first' });
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    await f.runtime.close(); await cancelled; expect(receivedSignal.aborted).toBe(true);
    ready(dynamicChannel()); await Promise.resolve(); await Promise.resolve();
    expect(f.createBootstrap).not.toHaveBeenCalled(); expect(f.createInvoker).not.toHaveBeenCalled(); expect(f.createClient).not.toHaveBeenCalled();
});
it('replacement of a retired lazy consumer shares the pending owned channel without creating its retired client', async () => {
    let ready!: (value: ReturnType<typeof dynamicChannel>) => void;
    const resolveControlConfiguration = vi.fn(() => new Promise(resolve => { ready = resolve; }));
    const f = fixture({ resolveControlConfiguration }), first = f.runtime.getServiceOptions().soloistPcmClient;
    const old = first.prepare({ session: 'old' }), cancelled = expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(resolveControlConfiguration).toHaveBeenCalledOnce()); first.dispose();
    const next = f.runtime.getServiceOptions().soloistPcmClient, current = next.prepare({ session: 'current' });
    ready(dynamicChannel()); await cancelled; await current;
    expect(resolveControlConfiguration).toHaveBeenCalledOnce(); expect(f.createClient).toHaveBeenCalledOnce();
    expect(f.clients[0].prepare).toHaveBeenCalledWith({ session: 'current' }); await f.runtime.close();
});
it('rejects an unverified or root dynamic channel before constructing any private transport', async () => {
    const f = fixture({ resolveControlConfiguration: async () => ({ ...dynamicChannel(), user: 'root' }) });
    await expect(f.runtime.getServiceOptions().soloistPcmClient.prepare({ session: 'first' })).rejects.toThrow('soloist-configuration-invalid');
    expect(f.createBootstrap).not.toHaveBeenCalled(); expect(f.createInvoker).not.toHaveBeenCalled(); await f.runtime.close();
});
it('quit closes the client and invalidates private HTTP credentials exactly once without touching a caller-owned appliance', async () => {
    const f = fixture(); f.runtime.getServiceOptions(); await f.runtime.close(); await f.runtime.close();
    expect(f.clients[0].dispose).toHaveBeenCalledTimes(1); expect(f.invoke.dispose).toHaveBeenCalledTimes(1);
    expect(() => f.runtime.getServiceOptions()).toThrow('runtime-closed'); expect(f.owner.readFresh).not.toHaveBeenCalled();
});
it.each([{ keyPath: 'relative/id' }, { deviceName: '' }, { knownHostsPath: knownHostsPath + '\n' },
    { ownedSoloist: {} }, { applyQuality: 'renderer-value' }, { pid: 123 }, { sshPort: '33991' }, { pcmPort: 65536 },
    { user: 'folia;arbitrary' }])('rejects an invalid explicit main configuration rather than silently downgrading: %o', value => {
    expect(() => fixture(value)).toThrow('soloist-configuration-invalid');
});
