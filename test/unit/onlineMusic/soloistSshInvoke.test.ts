import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
const { createSoloistSshInvoker } = createRequire(import.meta.url)('../../../electron/spotify/soloistSshInvoke.cjs');
function fixture(timeoutMs = 12000) {
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), stdout: new EventEmitter(), kill: vi.fn() });
    const spawnProcess = vi.fn((_executable: string, _args: string[], _options: unknown) => child), invoke = createSoloistSshInvoker({
        keyPath: path.join(os.tmpdir(), 'private', 'appliance_id'), knownHostsPath: path.join(os.tmpdir(), 'private', 'known_hosts'), spawnProcess, timeoutMs });
    return { child, spawnProcess, invoke };
}
it('uses a fixed SSH command, pinned host identity and bounded JSON stdin instead of embedding payload in argv', async () => {
    const f = fixture(), payload = { uri: 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp', observe_seconds: 1 };
    const pending = f.invoke('soloist', 'status', payload);
    const args = f.spawnProcess.mock.calls[0][1] as string[];
    expect(args.join(' ')).not.toContain(payload.uri); expect(args.at(-1)).toBe('runuser -u folia -- /opt/folia/venv/bin/python /opt/folia/soloist-control.py status --stdin-json');
    expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('root@127.0.0.1');
    expect(f.spawnProcess.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(JSON.parse(f.child.stdin.end.mock.calls[0][0])).toEqual(payload);
    const bytes = Buffer.from(JSON.stringify({ result: '中文' })); for (const byte of bytes) f.child.stdout.emit('data', Buffer.from([byte]));
    f.child.emit('close', 0); expect(await pending).toEqual({ result: '中文' });
});
it('kills an aborted invocation and ignores late private output', async () => {
    const f = fixture(), controller = new AbortController(), pending = f.invoke('pcm', 'prepare', {}, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); controller.abort();
    f.child.stdout.emit('data', Buffer.from('{"private":"token"}')); f.child.emit('close', 0); await rejected; expect(f.child.kill).toHaveBeenCalledOnce();
});
it('rejects oversized output, command injection and invalid successful JSON without exposing child text', async () => {
    const f = fixture(); await expect(f.invoke('pcm', 'prepare; evil', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(f.spawnProcess).not.toHaveBeenCalled();
    const oversized = f.invoke('pcm', 'status', {}); f.child.stdout.emit('data', Buffer.alloc(65537)); await expect(oversized).rejects.toMatchObject({ code: 'CONTROL_RESPONSE_TOO_LARGE' });
    const g = fixture(), invalid = g.invoke('pcm', 'status', {}); g.child.stdout.emit('data', Buffer.from('private-secret-error')); g.child.emit('close', 0);
    await expect(invalid).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_INVALID', message: 'Spotify Soloist: CONTROL_PROTOCOL_INVALID' });
});
it('enforces a control deadline rather than leaving a cancelled helper running', async () => {
    const f = fixture(100); const pending = f.invoke('pcm', 'status', {});
    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' }); expect(f.child.kill).toHaveBeenCalledOnce();
});
