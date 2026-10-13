import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { createNativeHost } = createRequire(import.meta.url)('../../../electron/spotify/nativeHost.cjs');
const hello = { event: 'hello', component: 'folia-spotify-playback', protocolVersion: 1, version: '0.1.0', capabilities: ['status', 'audio'] };
const emit = (child: EventEmitter & { stdout: EventEmitter }, value: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));

// Fake child sessions exercise cancellation, Unicode framing and credential boundaries without network access.
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(), kill: vi.fn() });
  const spawnProcess = vi.fn(() => child);
  const vault = { token: vi.fn(async () => 'test-private-token') };
  const host = createNativeHost({ vault, executable: 'test-helper', spawnProcess });
  return { child, spawnProcess, vault, host };
}
describe('Spotify native host', () => {
  it('keeps credentials out of arguments and preserves split UTF-8 output', async () => {
    const f = fixture(); const pending = f.host.request({ action: 'status' }); await Promise.resolve();
    expect(f.spawnProcess).toHaveBeenCalledWith('test-helper', [], expect.objectContaining({ windowsHide: true }));
    expect(f.child.stdin.end).not.toHaveBeenCalled(); emit(f.child, hello);
    expect(JSON.parse(f.child.stdin.end.mock.calls[0][0]).accessToken).toBe('test-private-token');
    const bytes = Buffer.from(JSON.stringify({ event: 'result', result: { name: '中文' } }) + '\n');
    for (const byte of bytes) f.child.stdout.emit('data', Buffer.from([byte]));
    f.child.emit('close', 0); expect(await pending).toEqual({ name: '中文' });
  });
  it('kills pending sessions on logout and discards late output', async () => {
    const f = fixture(); const pending = f.host.request({ action: 'status' });
    const rejected = expect(pending).rejects.toThrow('request-cancelled'); await Promise.resolve();
    f.host.clear(); f.child.stdout.emit('data', Buffer.from('{"event":"result","result":{}}\n')); f.child.emit('close', 0);
    await rejected; expect(f.child.kill).toHaveBeenCalledTimes(1);
  });
  it('does not start a session when authorization races with cancellation', async () => {
    const f = fixture(); const pending = f.host.request({ action: 'status' }); f.host.clear();
    await expect(pending).rejects.toThrow('request-cancelled'); expect(f.spawnProcess).not.toHaveBeenCalled();
  });
  it('supports per-request cancellation and refuses incomplete successful exits', async () => {
    const f = fixture(), controller = new AbortController();
    const pending = f.host.request({ action: 'status' }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('request-cancelled'); await Promise.resolve(); controller.abort(); await rejected;
    const g = fixture(); const empty = g.host.request({ action: 'status' }); await Promise.resolve(); emit(g.child, hello); g.child.emit('close', 0);
    await expect(empty).rejects.toThrow('native-no-result');
  });
  it('sanitizes native errors and validates identifiers before touching credentials', async () => {
    const f = fixture(); await expect(f.host.request({ action: 'song', id: '../../private' })).rejects.toThrow('invalid-id');
    expect(f.vault.token).not.toHaveBeenCalled();
    const pending = f.host.request({ action: 'status' }); await Promise.resolve();
    emit(f.child, hello);
    f.child.stdout.emit('data', Buffer.from('{"event":"failed","code":"https://secret.example/token"}\n')); f.child.emit('close', 1);
    await expect(pending).rejects.toThrow('Spotify: native-failed');
  });
  it.each([{ ...hello, protocolVersion: 2 }, { ...hello, component: 'other' }, { ...hello, capabilities: [] },
    { event: 'result', result: {} }])('rejects incompatible helpers before sending credentials: %j', async handshake => {
    const f = fixture(), pending = f.host.request({ action: 'status' }); await Promise.resolve();
    emit(f.child, handshake);
    await expect(pending).rejects.toThrow('native-incompatible');
    expect(f.child.stdin.end).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it('rejects a successful exit without a handshake', async () => {
    const f = fixture(), pending = f.host.request({ action: 'status' }); await Promise.resolve();
    f.child.emit('close', 0); await expect(pending).rejects.toThrow('native-incompatible');
    expect(f.child.stdin.end).not.toHaveBeenCalled();
  });
  it('reports early encoded source but keeps ownership until validated final process exit', async () => {
    const f = fixture(), progress = vi.fn();
    const pending = f.host.request({ action: 'audio-stream-encoded', trackId: '0123456789012345678901', output: 'private-output', quality: 'high' }, { onProgress: progress });
    await Promise.resolve(); emit(f.child, { ...hello, capabilities: [...hello.capabilities, 'audio-stream-encoded'] });
    const first = { event: 'stream-ready', bytes: 100, source: { sourceEncoding: 'vorbis' } };
    emit(f.child, first); expect(progress).toHaveBeenCalledWith(first);
    let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    emit(f.child, { event: 'ready', bytes: 200 }); f.child.emit('close', 0);
    expect(await pending).toEqual({ event: 'ready', bytes: 200 });
  });
  it('kills a stream producer on a duplicated early-ready message', async () => {
    const f = fixture();
    const pending = f.host.request({ action: 'audio-stream-encoded', trackId: '0123456789012345678901' });
    await Promise.resolve(); emit(f.child, { ...hello, capabilities: [...hello.capabilities, 'audio-stream-encoded'] });
    emit(f.child, { event: 'stream-ready' }); emit(f.child, { event: 'stream-ready' });
    await expect(pending).rejects.toThrow('native-stream-ready'); expect(f.child.kill).toHaveBeenCalledOnce();
  });
});
