import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createRpc } = createRequire(import.meta.url)('../../../electron/hqplayer/rpc.cjs');

// Exercise actual RPC deadlines and process failure, without starting Desktop or touching hardware.
function fixture() {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(), stderr: new EventEmitter(), stdout: new EventEmitter() });
    const onEvent = vi.fn(); return { child, onEvent, rpc: createRpc('verified.cjs', { fork: () => child, onEvent, timeoutMs: 20 }) };
}
it('rejects all pending requests on crash without restarting automatically', async () => {
    const f = fixture(); const first = f.rpc.request('prepare').catch((e: any) => e.code), second = f.rpc.request('configuration').catch((e: any) => e.code);
    f.child.emit('exit', 1); expect(await first).toBe('COMPONENT_CRASHED'); expect(await second).toBe('COMPONENT_CRASHED');
    await expect(f.rpc.request('prepare')).rejects.toMatchObject({ code: 'COMPONENT_CRASHED' }); expect(f.onEvent).toHaveBeenCalledOnce();
});
it('kills an unresponsive worker at the request deadline', async () => {
    const f = fixture(); await expect(f.rpc.request('prepare')).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' }); expect(f.child.kill).toHaveBeenCalledOnce();
});
it('does not destroy playback for an ordinary failed command', async () => {
    const f = fixture(); const first = f.rpc.request('command'); f.child.emit('message', { id: 1, ok: false, errorCode: 'HQPLAYER_COMMAND_REJECTED' });
    await expect(first).rejects.toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
    const next = f.rpc.request('configuration'); f.child.emit('message', { id: 2, ok: true, result: { available: true } });
    expect(await next).toEqual({ available: true }); expect(f.child.kill).not.toHaveBeenCalled();
});
