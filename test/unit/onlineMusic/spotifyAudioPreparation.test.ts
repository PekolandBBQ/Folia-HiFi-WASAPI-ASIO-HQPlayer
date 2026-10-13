import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Real temporary files with a fake decoder cover cancellation and account-session cache boundaries.
const { createAudioPreparation } = createRequire(import.meta.url)('../../../electron/spotify/audioPreparation.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(clean => clean())); });
const id = '0123456789012345678901';
function encodedEvent(bytes: number, pcmFrames: number, quality = 'high') {
  return { representation: 'ogg-vorbis', bytes, pcmFrames, quality, source: { sourceEncoding: 'vorbis', sourceContainer: 'ogg',
    sourceEncodingVerified: true, sourceLossless: false, sourceSampleRate: 44100, sourceChannels: 2, sourceBitrate: quality === 'high' ? 320000 : 160000 } };
}
function oggPrefix(quality = 'high') {
  const bytes = Buffer.alloc(58); bytes.write('OggS'); bytes[5] = 2; bytes[26] = 1; bytes[27] = 30;
  bytes.write('\x01vorbis', 28); bytes[39] = 2; bytes.writeUInt32LE(44100, 40); bytes.writeInt32LE(quality === 'high' ? 320000 : 160000, 48); return bytes;
}
function floatWave() {
  const bytes = Buffer.alloc(60); bytes.write('RIFF'); bytes.writeUInt32LE(52, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(44100 * 8, 28); bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(16, 40); return bytes;
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'folia-preparation-test-'));
  const vault = { token: vi.fn(async () => 'fake-token') };
  const revoke = vi.fn(), media = { add: vi.fn(async () => ({ url: 'http://127.0.0.1/test', revoke })), clear: vi.fn(), close: vi.fn() };
  const native = { request: vi.fn(async (input: any, options: any): Promise<any> => {
    options.onProgress({ event: 'metadata', durationMs: 1000 }); options.onProgress({ event: 'decoding', positionMs: 500 });
    await writeFile(input.output, floatWave()); return { samples: 4, representation: 'float32', sampleRate: 44100, channels: 2 };
  }) };
  const audio = createAudioPreparation({ directory, native, vault, media });
  cleanups.push(async () => { await audio.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, audio, native, vault, media, revoke };
}
describe('Spotify account-session audio preparation', () => {
  it('separates quality caches and never claims lossless support', async () => {
    const f = await fixture();
    const standard = await f.audio.prepare(id, randomUUID(), undefined, 'standard');
    const high = await f.audio.prepare(id, randomUUID(), undefined, 'high');
    expect(standard.requestedQuality).toBe('standard'); expect(high.requestedQuality).toBe('high');
    expect(standard.quality).toBeNull(); expect(high.quality).toBeNull(); expect(high.actualQuality).toBeNull();
    expect(high.sourceInfo).toEqual({ codec: null, container: null, encodingVerified: false, sampleRate: null, channels: null,
      bitDepth: null, bitrate: null, bitrateKind: null, lossless: null });
    expect(high.preparedAudio).toEqual({ representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 });
    expect(await f.audio.prepare(id, randomUUID(), undefined, 'standard')).toBe(standard);
    expect(f.native.request.mock.calls.map(([input]) => input.quality)).toEqual(['standard', 'high']);
    for (const quality of ['lossless', 'hires', 'unknown'])
      await expect(f.audio.prepare(id, randomUUID(), undefined, quality)).rejects.toThrow('quality-unsupported');
    expect(f.native.request).toHaveBeenCalledTimes(2);
  });
  it('reuses prepared tracks, reports actual stages and removes audio on clear', async () => {
    const f = await fixture(), progress = vi.fn();
    const source = await f.audio.prepare(id, randomUUID(), progress);
    expect(await f.audio.prepare(id, randomUUID())).toBe(source); expect(f.native.request).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ stage: 'decode', loaded: 500, total: 1000, unit: 'milliseconds' });
    expect(progress).toHaveBeenCalledWith({ stage: 'validate' });
    await f.audio.clear(); expect(f.media.clear).toHaveBeenCalled();
    for (const folder of await readdir(f.directory)) expect(await readdir(path.join(f.directory, folder))).toEqual(['owner.json']);
  });
  it('cancels while credentials are still loading without starting the decoder', async () => {
    const f = await fixture(), requestId = randomUUID();
    const pending = f.audio.prepare(id, requestId); f.audio.cancel(requestId);
    await expect(pending).rejects.toThrow('request-cancelled'); expect(f.native.request).not.toHaveBeenCalled();
  });
  it('does not publish late decoded data after logout', async () => {
    const f = await fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.native.request.mockImplementation(async input => {
      await writeFile(input.output, Buffer.alloc(60)); entered(); await new Promise<void>(resolve => { finish = resolve; }); return { samples: 4 };
    });
    const pending = f.audio.prepare(id, randomUUID()), rejected = expect(pending).rejects.toThrow('request-cancelled');
    await started; const clearing = f.audio.clear(); finish(); await clearing; await rejected;
    expect(f.media.add).not.toHaveBeenCalled();
  });
  it('rejects truncated audio before publishing a URL', async () => {
    const f = await fixture();
    f.native.request.mockImplementation(async input => { await writeFile(input.output, Buffer.alloc(44)); return { samples: 4 }; });
    await expect(f.audio.prepare(id, randomUUID())).rejects.toThrow('invalid-audio'); expect(f.media.add).not.toHaveBeenCalled();
  });
  it('rejects a whole-file container that does not match the declared prepared PCM', async () => {
    const f = await fixture();
    f.native.request.mockImplementation(async input => {
      const bytes = floatWave(); bytes.writeUInt16LE(1, 20); await writeFile(input.output, bytes);
      return { samples: 4, representation: 'float32', sampleRate: 44100, channels: 2, quality: 'high' };
    });
    await expect(f.audio.prepare(id, randomUUID())).rejects.toThrow('invalid-stream-audio');
    expect(f.media.add).not.toHaveBeenCalled();
  });
  it('keeps a delivered lower original tier separate from a higher requested tier', async () => {
    const f = await fixture();
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => ({ url: 'http://127.0.0.1/original.ogg', revoke: f.revoke, completed: options.completion })) });
    f.native.request.mockImplementation(async (input, options) => {
      expect(input.quality).toBe('high'); await writeFile(input.output, oggPrefix('standard'));
      const event = encodedEvent(58, 44100, 'standard'); event.quality = 'high';
      options.onProgress({ event: 'stream-ready', ...event }); return event;
    });
    const source = await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    expect(source.requestedQuality).toBe('high'); expect(source.actualQuality).toBe('standard'); expect(source.quality).toBe('standard');
    expect(source.sourceInfo).toEqual(expect.objectContaining({ encodingVerified: true, bitrate: 160000, bitDepth: null, lossless: false }));
  });
  it('keeps an unrecognized delivered Vorbis bitrate unknown instead of copying the requested tier', async () => {
    const f = await fixture();
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => ({ url: 'http://127.0.0.1/unknown-tier.ogg', revoke: f.revoke, completed: options.completion })) });
    f.native.request.mockImplementation(async (input, options) => {
      const bytes = oggPrefix(); bytes.writeInt32LE(192000, 48); await writeFile(input.output, bytes);
      const event = encodedEvent(58, 44100); event.source.sourceBitrate = 192000;
      options.onProgress({ event: 'stream-ready', ...event }); return event;
    });
    const source = await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    expect(source.requestedQuality).toBe('high'); expect(source.actualQuality).toBeNull(); expect(source.quality).toBeNull();
    expect(source.sourceInfo.bitrate).toBe(192000); expect(source.sourceInfo.encodingVerified).toBe(true);
  });
  it('returns a growing source early, waits for true EOF for whole mode and validates original header telemetry', async () => {
    const f = await fixture(); let finish!: () => void, completed!: () => Promise<unknown>;
    const finalGate = new Promise<void>(resolve => { finish = resolve; });
    const addGrowing = vi.fn(async (_file: string, options: { completion: Promise<unknown> }) => {
      completed = () => options.completion; return { url: 'http://127.0.0.1/growing.ogg', revoke: f.revoke, completed: options.completion };
    });
    Object.assign(f.media, { addGrowing });
    f.native.request.mockImplementation(async (input, options) => {
      expect(input.action).toBe('audio-stream-encoded'); await writeFile(input.output, oggPrefix(input.quality));
      options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100, input.quality) });
      await finalGate; await appendFile(input.output, Buffer.alloc(32)); return encodedEvent(90, 88200, input.quality);
    });
    const source = await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    expect(source.streaming).toBe(true); expect(source.actualQuality).toBe('high');
    expect(source.sourceInfo).toEqual(expect.objectContaining({ codec: 'vorbis', bitrate: 320000, bitDepth: null, lossless: false }));
    expect(await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true })).toBe(source);
    let wholeSettled = false;
    const whole = f.audio.prepare(id, randomUUID(), undefined, 'high').then((value: unknown) => { wholeSettled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(wholeSettled).toBe(false);
    finish(); await completed(); expect(await whole).toBe(source); expect(f.native.request).toHaveBeenCalledOnce();
  });
  it('revokes an already published growing source when its producer fails later', async () => {
    const f = await fixture(); let fail!: () => void;
    const finalGate = new Promise<void>(resolve => { fail = resolve; });
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => {
      void options.completion.catch(() => {}); return { url: 'http://127.0.0.1/growing.ogg', revoke: f.revoke, completed: options.completion };
    }) });
    f.native.request.mockImplementation(async (input, options) => {
      await writeFile(input.output, oggPrefix()); options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100) });
      await finalGate; throw new Error('source-failed');
    });
    const source = await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true }); expect(source.url).toContain('growing');
    fail(); await f.audio.clear(); expect(f.revoke).toHaveBeenCalled();
    for (const folder of await readdir(f.directory)) expect(await readdir(path.join(f.directory, folder))).toEqual(['owner.json']);
  });
  it('cancels a growing producer after URL publication on logout and discards any late success', async () => {
    const f = await fixture(); let aborted = false;
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => {
      void options.completion.catch(() => {}); return { url: 'http://127.0.0.1/growing.ogg', revoke: f.revoke, completed: options.completion };
    }) });
    f.native.request.mockImplementation(async (input, options) => {
      await writeFile(input.output, oggPrefix()); options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100) });
      await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
      return encodedEvent(58, 88200);
    });
    await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    await f.audio.clear(); expect(aborted).toBe(true); expect(f.revoke).toHaveBeenCalled();
  });
  it('retries the same track and requested tier as float streaming only for an explicit unsupported encoding before publication', async () => {
    const f = await fixture();
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => ({ url: 'http://127.0.0.1/fallback.wav', revoke: f.revoke, completed: options.completion })) });
    f.native.request.mockImplementation(async (input, options) => {
      if (input.action === 'audio-stream-encoded') throw Object.assign(new Error('Spotify: encoded-format-unsupported'), { code: 'unsupported' });
      expect(input.trackId).toBe(id); expect(input.quality).toBe('high'); await writeFile(input.output, floatWave());
      const ready = { representation: 'float32', sampleRate: 44100, channels: 2, samples: 4 };
      options.onProgress({ event: 'stream-ready', ...ready }); return ready;
    });
    const source = await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    expect(f.native.request.mock.calls.map(([input]) => input.action)).toEqual(['audio-stream-encoded', 'audio-stream']);
    expect(source.quality).toBeNull(); expect(source.requestedQuality).toBe('high'); expect(source.actualQuality).toBeNull();
    expect(source.sourceInfo).toEqual(expect.objectContaining({ codec: null, encodingVerified: false, bitrate: null, lossless: null }));
    expect(source.preparedAudio).toEqual({ representation: 'float32', sampleRate: 44100, channels: 2, bitDepth: 32 });
  });
  it.each(['network', 'auth-required', 'not-playable', 'invalid-response'])('does not retry a %s failure as another producer', async code => {
    const f = await fixture(); f.native.request.mockRejectedValue(Object.assign(new Error('Spotify: source-failed'), { code }));
    await expect(f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true })).rejects.toThrow('source-failed');
    expect(f.native.request).toHaveBeenCalledOnce(); expect(f.media.add).not.toHaveBeenCalled();
  });
  it('does not fall back on an unsupported-encoding error after a growth handle was already published', async () => {
    const f = await fixture(); let fail!: () => void;
    const finalGate = new Promise<void>(resolve => { fail = resolve; });
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => {
      void options.completion.catch(() => {}); return { url: 'http://127.0.0.1/growing.ogg', revoke: f.revoke, completed: options.completion };
    }) });
    f.native.request.mockImplementation(async (input, options) => {
      await writeFile(input.output, oggPrefix()); options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100) });
      await finalGate; throw Object.assign(new Error('Spotify: encoded-format-unsupported'), { code: 'unsupported' });
    });
    await f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true });
    fail(); await f.audio.clear(); expect(f.native.request).toHaveBeenCalledOnce(); expect(f.revoke).toHaveBeenCalled();
  });
  it('rejects a prefix whose delivered codec header does not match the claimed original telemetry', async () => {
    const f = await fixture();
    f.native.request.mockImplementation(async (input, options) => {
      await writeFile(input.output, oggPrefix('standard')); options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100, 'high') });
      return encodedEvent(58, 44100, 'high');
    });
    await expect(f.audio.prepare(id, randomUUID(), undefined, 'high', { streaming: true })).rejects.toThrow('invalid-stream-audio');
    expect(f.native.request).toHaveBeenCalledOnce();
  });
  it('reuses an active growth source even at the four-producer limit while refusing another distinct track', async () => {
    const f = await fixture();
    Object.assign(f.media, { addGrowing: vi.fn(async (_file, options) => {
      void options.completion.catch(() => {}); return { url: 'http://127.0.0.1/growing.ogg', revoke: f.revoke, completed: options.completion };
    }) });
    f.native.request.mockImplementation(async (input, options) => {
      await writeFile(input.output, oggPrefix()); options.onProgress({ event: 'stream-ready', ...encodedEvent(58, 44100) });
      await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return encodedEvent(58, 44100);
    });
    const ids = Array.from({ length: 4 }, (_, index) => '01234567890123456789' + String(index).padStart(2, '0'));
    const sources = await Promise.all(ids.map(track => f.audio.prepare(track, randomUUID(), undefined, 'high', { streaming: true })));
    expect(await f.audio.prepare(ids[0], randomUUID(), undefined, 'high', { streaming: true })).toBe(sources[0]);
    await expect(f.audio.prepare('0123456789012345678999', randomUUID(), undefined, 'high', { streaming: true })).rejects.toThrow('preparation-busy');
    expect(f.native.request).toHaveBeenCalledTimes(4); await f.audio.clear();
  });
});
