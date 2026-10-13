import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// test/unit/nativeAudio/helper.test.ts — process failure recovery and protocol error isolation.
const { createHelper } = createRequire(import.meta.url)('../../../electron/nativeAudio/helper.cjs');
function fixture(timeout = 1000) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawn = vi.fn(() => child), event = vi.fn();
    const helper = createHelper('test-component', event, spawn, timeout);
    return { child, spawn, event, helper };
}
it('rejects pending calls after a crash and does not restart for cleanup', async () => {
    const { child, spawn, event, helper } = fixture();
    const pending = helper.request({ action: 'hello' });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'COMPONENT_CRASHED' });
    child.emit('exit', 1);
    await assertion;
    await helper.request({ action: 'stop' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith({ event: 'error', errorCode: 'COMPONENT_CRASHED' });
});
it('kills a timed out component exactly once and reports a fixed timeout code', async () => {
    const { child, event, helper } = fixture(10);
    await expect(helper.request({ action: 'hello' })).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
    child.emit('exit', 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledTimes(1);
});
it('never sends legacy raw error strings or URLs to the renderer', async () => {
    const { child, event, helper } = fixture();
    const pending = helper.request({ action: 'hello' });
    child.stdout.write(JSON.stringify({ id: 1, ok: true, result: {} }) + '\n');
    await pending;
    child.stdout.write(JSON.stringify({ event: 'error', session: 'track', error: 'token=private https://example.org/private' }) + '\n');
    expect(event).toHaveBeenCalledWith({ event: 'error', session: 'track', errorCode: 'NATIVE_REQUEST_FAILED' });
    helper.dispose();
});
it('logs sanitized driver diagnostics before process exit without emitting a playback failure', async () => {
    const { child, event, helper } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const pending = helper.request({ action: 'hello' });
        child.stdout.write(JSON.stringify({ id: 1, ok: true, result: {} }) + '\n');
        await pending;
        child.stderr.write('device busy 0x8889000A token=private https://example.org/secret');
        expect(log).toHaveBeenCalledWith(expect.stringContaining('device busy 0x8889000A'));
        expect(log.mock.calls.flat().join(' ')).not.toMatch(/private|example.org/);
        expect(event).not.toHaveBeenCalled();
    } finally { helper.dispose(); log.mockRestore(); }
});


it('does not acknowledge Stop or reopen after kill until the exact old process exit is observed', async () => {
    const { child, spawn, helper } = fixture(15);
    await expect(helper.request({ action: 'hello' })).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(helper.request({ action: 'stop' })).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
    await expect(helper.request({ action: 'stream-load' })).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
    expect(spawn).toHaveBeenCalledOnce();
    const stopped = helper.request({ action: 'stop' }); child.emit('exit', 0); await stopped;
    expect(spawn).toHaveBeenCalledOnce();
});

it('a delayed duplicate old exit cannot cancel or retire the new driver owner', async () => {
    const { child, spawn, helper } = fixture(15);
    await expect(helper.request({ action: 'hello' })).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
    const next = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    spawn.mockReturnValue(next);
    next.stdin.once('data', () => {
        child.emit('exit', 1); child.emit('close', 1);
        next.stdout.write(JSON.stringify({ id: 2, ok: true, result: { session: 'new' } }) + '\n');
    });
    const loading = helper.request({ action: 'stream-load' });
    expect(spawn).toHaveBeenCalledOnce(); child.emit('exit', 1);
    expect(await loading).toEqual({ session: 'new' }); expect(next.kill).not.toHaveBeenCalled();
    helper.dispose(); next.emit('exit', 0);
});
