const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSoloistSetupHandler, KEY_PAGE } = require('../../electron/spotify/soloistSetupHandler.cjs');
// Only explicit setup can save a key, start a receiver or open the fixed page.
function fixture() {
    const calls = [], status = { hasKey: false, state: 'unconfigured' };
    const appliance = { publicStatus: async () => { calls.push('status'); return { ...status }; },
        saveKey: async value => { calls.push(['saveKey', value]); status.hasKey = true; status.state = 'stopped'; return { ...status }; },
        startSetup: async options => { calls.push('start'); options.onProgress({ stage: 'official-download', loaded: 5, total: 10 }); return { hasKey: true, state: 'pairing-required' }; },
        stopSetup: async () => { calls.push('stop'); status.state = 'stopped'; } };
    return { calls, request: createSoloistSetupHandler({ appliance, openExternal: async url => calls.push(['open', url]), revokePlayback: async () => calls.push('revoke') }) };
}
test('reading status never starts playback or revokes the current song', async () => {
    const f = fixture(); assert.deepEqual(await f.request({ action: 'playbackSetup', operation: 'status' }), { hasKey: false, state: 'unconfigured' });
    assert.deepEqual(f.calls, ['status']);
});
test('saving a private key revokes the old playback first and only returns public status', async () => {
    const f = fixture(), key = 'spak_' + 'A'.repeat(32);
    const value = await f.request({ action: 'playbackSetup', operation: 'saveKey', keyValue: key });
    assert.deepEqual(f.calls, ['revoke', ['saveKey', key]]); assert.deepEqual(value, { hasKey: true, state: 'stopped' });
    assert.equal(JSON.stringify(value).includes(key), false);
});
test('setup progress retains measured byte counts without returning guest paths', async () => {
    const f = fixture(), progress = [];
    const value = await f.request({ action: 'playbackSetup', operation: 'start', requestId: 'a-123' }, event => progress.push(event));
    assert.deepEqual(progress, [{ stage: 'download', loaded: 5, total: 10 }]); assert.equal(value.state, 'pairing-required'); assert.deepEqual(f.calls, ['start']);
});
test('stop revokes playback before releasing the receiver', async () => {
    const f = fixture(); await f.request({ action: 'playbackSetup', operation: 'stop' }); assert.deepEqual(f.calls, ['revoke', 'stop', 'status']);
});
test('the official key page cannot be replaced with a renderer URL', async () => {
    const f = fixture(); await f.request({ action: 'playbackSetup', operation: 'keyPage' }); assert.deepEqual(f.calls, [['open', KEY_PAGE], 'status']);
    await assert.rejects(f.request({ action: 'playbackSetup', operation: 'keyPage', url: 'https://example.com' }), { code: 'invalid-response' });
});
test('malformed setup input does not read secrets, revoke or start anything', async () => {
    const f = fixture();
    for (const input of [{ action: 'playbackSetup', operation: 'saveKey', keyValue: 'bad' },
        { action: 'playbackSetup', operation: 'saveKey', keyValue: 'spak_' + 'A'.repeat(129) },
        { action: 'playbackSetup', operation: 'saveKey', keyValue: 'spak_' + 'A'.repeat(20) + '_' },
        { action: 'playbackSetup', operation: 'start', keyValue: 'unexpected' },
        { action: 'playbackSetup', operation: 'start', sshPort: 22 },
        { action: 'playbackSetup', operation: 'start', requestId: '../host' },
        { action: 'playbackSetup', operation: 'unknown' }]) await assert.rejects(f.request(input), { code: 'invalid-response' });
    assert.deepEqual(f.calls, []);
});

test('a PCM cleanup error still stops the owned appliance without saving a replacement key', async () => {
    for (const operation of ['stop', 'saveKey']) {
        const calls = [], failure = Object.assign(new Error('private cleanup failed'), { code: 'unavailable' });
        const appliance = { publicStatus: async () => ({ hasKey: true, state: 'stopped' }),
            saveKey: async () => calls.push('save-key'), startSetup: async () => {}, stopSetup: async () => calls.push('owner-stopped') };
        const request = createSoloistSetupHandler({ appliance, openExternal: async () => {},
            revokePlayback: async () => { calls.push('revoke'); throw failure; } });
        await assert.rejects(request({ action: 'playbackSetup', operation,
            ...(operation === 'saveKey' ? { keyValue: 'spak_' + 'A'.repeat(32) } : {}) }), error => error === failure);
        assert.deepEqual(calls, ['revoke', 'owner-stopped']);
    }
});
