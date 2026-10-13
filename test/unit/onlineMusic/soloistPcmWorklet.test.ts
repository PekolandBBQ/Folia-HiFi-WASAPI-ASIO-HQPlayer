import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// test/unit/onlineMusic/soloistPcmWorklet.test.ts: execute the actual processor with real PCM and render quanta.
function fixture() {
    const messages: any[] = []; let Constructor: any;
    vm.runInNewContext(readFileSync(new URL('../../../src/services/onlineMusic/soloistPcmWorklet.js', import.meta.url), 'utf8'), {
        AudioWorkletProcessor: class { port = { postMessage: (data: any) => messages.push(data), onmessage: (_: any) => {} }; },
        Uint8Array, Float32Array, DataView,
        registerProcessor: (_name: string, value: any) => { Constructor = value; },
    });
    const processor = new Constructor();
    const send = (data: any) => processor.port.onmessage({ data });
    const render = (frames = 128) => { const stereo = [new Float32Array(frames), new Float32Array(frames)]; processor.process([], [stereo]); return stereo; };
    send({ type: 'reset', generation: 1, playing: true });
    return { processor, send, render, messages };
}
it('preserves signed PCM sample order and holds the song clock on actual starvation', () => {
    const f = fixture(), block = Buffer.alloc(16);
    block.writeInt32LE(-2147483648, 0); block.writeInt32LE(1073741824, 4); block.writeInt32LE(0, 8); block.writeInt32LE(-1073741824, 12);
    f.send({ type: 'block', generation: 1, data: block });
    const [left, right] = f.render(); expect([...left.slice(0, 3)]).toEqual([-1, 0, 0]); expect([...right.slice(0, 3)]).toEqual([0.5, -0.5, 0]);
    expect(f.processor.frames).toBe(2); f.render(); expect(f.processor.frames).toBe(2);
    expect(f.messages.at(-1)).toMatchObject({ frames: 2, buffering: true, ended: false });
    for (let index = 0; index < 100; index++) f.render();
    expect(f.messages.length).toBeLessThan(10); // starvation does not flood IPC every 128-frame callback.
});
it('pause/reset discards buffered old-generation audio and a stale delivery cannot reenter', () => {
    const f = fixture(); f.send({ type: 'block', generation: 1, data: Buffer.alloc(65536, 1) });
    f.send({ type: 'reset', generation: 2, playing: false }); f.send({ type: 'block', generation: 1, data: Buffer.alloc(8, 127) });
    expect(f.processor.queued).toBe(0); expect([...f.render()[0]]).toEqual(Array(128).fill(0));
    f.send({ type: 'block', generation: 2, data: Buffer.alloc(8, 1) }); f.render(); expect(f.processor.frames).toBe(0);
    f.send({ type: 'play', generation: 2, playing: true }); f.render(); expect(f.processor.frames).toBe(1);
});
it('declares EOF only after the last queued frame and rejects data beyond the one-second limit', () => {
    const f = fixture(); f.send({ type: 'block', generation: 1, data: Buffer.alloc(16) }); f.send({ type: 'complete', generation: 1 });
    f.render(1); expect(f.processor.queued).toBe(1); expect(f.messages.some(value => value.ended)).toBe(false);
    f.render(1); expect(f.messages.at(-1)).toMatchObject({ frames: 2, ended: true, buffering: false });
    f.send({ type: 'reset', generation: 2, playing: false });
    for (let index = 0; index < 5; index++) f.send({ type: 'block', generation: 2, data: Buffer.alloc(65536) });
    f.send({ type: 'block', generation: 2, data: Buffer.alloc(65536) });
    expect(f.processor.queued).toBe(40960); expect(f.messages.at(-1)).toMatchObject({ type: 'error', generation: 2 });
});
