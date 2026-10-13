const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
// Actual delivered component factories; only protocol/pipe/source boundaries are fake.
const componentPath = process.env.FOLIA_HQ_COMPONENT_PATH || path.resolve(__dirname, '../../component-candidate/hq-preview5/hqplayer-component.cjs');
function factories() {
    const servers = [];
    const net = { ...require('node:net'), createServer(callback) {
        const server = Object.assign(new EventEmitter(), {
            callback, listen(_name, done) { queueMicrotask(done); },
            close(done) { queueMicrotask(() => done()); },
        }); servers.push(server); return server;
    } };
    const source = fs.readFileSync(componentPath, 'utf8').split('//#region src/worker.cjs')[0];
    const exported = new Function('require', '__dirname', `${source}\nreturn { ...require_hqplayerHost(), ...require_hqplayerStreaming() };`)(name => name === 'node:net' ? net : require(name), path.dirname(componentPath));
    return { ...exported, servers };
}
const fault = () => Object.assign(new Error('sensitive protocol body must not escape'), { code: 'HQPLAYER_COMMAND_REJECTED' });
const turn = () => new Promise(resolve => setImmediate(resolve));
function hostFixture() {
    const calls = []; let failStop = false, stopGate;
    const attrs = { length: '120', rate: '44100', channels: '2', bits: '32' };
    const item = { hasAttribute: name => name in attrs, getAttribute: name => attrs[name] || '' };
    const protocol = Object.assign(new EventEmitter(), {
        isConnected: () => true, connect: async () => {}, close() {}, send() {},
        async request(action) { calls.push(action); if (action === 'Stop') { if (stopGate) await stopGate; if (failStop) throw fault(); }
            return action === 'PlaylistGet' ? { getElementsByTagName: () => [item] } : {}; },
    });
    const host = factories().createHQPlayerHost({ protocolFactory: () => protocol, findRunning: async () => [], probe: async () => true });
    return { host, calls, fail(value) { failStop = value; }, gate(value) { stopGate = value; } };
}
test('actual HQ host retains failed Stop owner and retries, rejecting Play/new load in between', async () => {
    const f = hostFixture();
    try {
        await f.host.load({ session: 'one', filePath: '/fake.wav' }); f.fail(true);
        await assert.rejects(f.host.stop('one'), error => error.code === 'HQPLAYER_COMMAND_REJECTED' && !error.message.includes('sensitive'));
        await assert.rejects(f.host.command('one', 'play'), { code: 'HQPLAYER_COMMAND_REJECTED' });
        await assert.rejects(f.host.load({ session: 'two', filePath: '/fake.wav' }), { code: 'HQPLAYER_COMMAND_REJECTED' });
        f.fail(false); await f.host.stop('one');
        assert.equal(f.calls.filter(action => action === 'Stop').length, 3);
        await assert.rejects(f.host.command('one', 'play'), /Stale/);
        await f.host.load({ session: 'two', filePath: '/fake.wav' });
        await f.host.stop('one'); // stale owner cannot stop the current output.
        assert.equal((await f.host.command('two', 'play')).playing, true);
    } finally { f.host.dispose(); }
});
test('actual HQ double Stop shares serialized ownership and holds completion for ACK', async () => {
    const f = hostFixture();
    try {
        await f.host.load({ session: 'one', filePath: '/fake.wav' });
        let release; f.gate(new Promise(resolve => { release = resolve; }));
        let done = false; const a = f.host.stop('one').then(() => { done = true; }); const b = f.host.stop('one');
        await turn(); assert.equal(done, false); assert.equal(f.calls.filter(action => action === 'Stop').length, 2);
        release(); await Promise.all([a, b]); assert.equal(f.calls.filter(action => action === 'Stop').length, 2);
    } finally { f.host.dispose(); }
});
function streamingFixture({ failSource = false } = {}) {
    const stops = [], sources = []; let failStop = true;
    const host = { load: async spec => ({ session: spec.session, streamGeneration: spec.stream.generation, position: 0, duration: 120 }),
        command: async () => ({ playing: true }), async stop(session, generation) { stops.push({ session, generation }); if (failStop) throw fault(); } };
    const streaming = factories().createHQPlayerStreaming({ host, sourceFactory: () => {
        const source = { closes: 0, state: { queuedSeconds: 0, capacityBytes: 1024 }, async start() { return 'http://127.0.0.1/fake'; },
            async close() { source.closes++; if (failSource) { failSource = false; throw fault(); } } }; sources.push(source); return source;
    } });
    const prepare = session => streaming.prepare({ session, sampleRate: 44100, channels: 2, bits32: true, durationHint: 120 });
    return { streaming, stops, sources, prepare, fail(value) { failStop = value; } };
}
test('actual HQ stream close keeps failed owner and prevents replacement until confirmed retry', async () => {
    const f = streamingFixture(); await f.prepare('one'); await turn();
    await assert.rejects(f.streaming.close('one'), { code: 'HQPLAYER_COMMAND_REJECTED' });
    assert.equal(f.streaming.owns('one'), true);
    await assert.rejects(f.streaming.command('one', 'play'), { code: 'HQPLAYER_COMMAND_REJECTED' });
    await assert.rejects(f.prepare('two'), { code: 'HQPLAYER_COMMAND_REJECTED' });
    assert.equal(f.sources.length, 1); f.fail(false);
    await Promise.all([f.streaming.close('one'), f.streaming.close('one')]);
    assert.equal(f.streaming.owns('one'), false); assert.equal(f.stops.length, 3);
    await f.prepare('two'); await f.streaming.close('one'); assert.equal(f.streaming.owns('two'), true);
    await f.streaming.close('two');
});
test('actual HQ stream close still attempts Stop if pipe/source cleanup fails, then retries both boundaries', async () => {
    const f = streamingFixture({ failSource: true }); await f.prepare('one'); await turn(); f.fail(false);
    await assert.rejects(f.streaming.close('one'), { code: 'HQPLAYER_COMMAND_REJECTED' });
    assert.equal(f.stops.length, 1); assert.equal(f.streaming.owns('one'), true);
    await f.streaming.close('one'); assert.equal(f.stops.length, 2); assert.equal(f.sources[0].closes, 2);
    assert.equal(f.streaming.owns('one'), false);
});
