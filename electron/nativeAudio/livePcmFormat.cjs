const { audioError } = require('./errors.cjs');

// Main-owned CABLE wire contract, separate from unknown original Spotify encoding.
const LIVE_PCM_CONTRACT = 'live-pcm-s32le-v1';
const LIVE_PCM_COMPONENT_VERSION = '0.1.4-preview.7';
const LIVE_PCM_RELEASE_CONTRACT = 'confirmed-stop-owner-v1';
const LIVE_PCM_TRANSPORT = Object.freeze({ contract: LIVE_PCM_CONTRACT, sampleFormat: 's32le',
    sampleRate: 44100, channels: 2, containerBits: 32, endianness: 'little', interleaved: true,
    framing: 'raw', frameBytes: 8 });

function requireLivePcmTransport(value, spec = value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== Object.keys(LIVE_PCM_TRANSPORT).length
        || Object.entries(LIVE_PCM_TRANSPORT).some(([key, expected]) => !Object.hasOwn(value, key) || value[key] !== expected)
        || spec?.sampleRate !== value.sampleRate || spec?.channels !== value.channels
        || spec && Object.hasOwn(spec, 'bits32') && spec.bits32 !== true) throw audioError('FORMAT_UNSUPPORTED', 'Invalid live PCM wire contract');
    return value;
}

function requireLivePcmReply(result, transport, { session, generation, pipeName } = {}) {
    requireLivePcmTransport(result?.transport);
    requireLivePcmTransport(transport);
    if (result.session !== session || !Number.isSafeInteger(result.generation) || result.generation < 1
        || generation !== undefined && result.generation !== generation
        || pipeName !== undefined && result.pipeName !== pipeName) throw audioError('CANCELLED');
    const input = result.receiverInput;
    if (result.ready === true) {
        if (!input || input.sampleRate !== transport.sampleRate || input.channels !== transport.channels
            || input.containerBits !== transport.containerBits) throw audioError('FORMAT_UNSUPPORTED', 'HQPlayer input does not match live PCM');
    } else if (result.ready !== false || input !== null) throw audioError('FORMAT_UNSUPPORTED', 'Unverified HQPlayer input');
    return result;
}

module.exports = { LIVE_PCM_CONTRACT, LIVE_PCM_COMPONENT_VERSION, LIVE_PCM_RELEASE_CONTRACT, LIVE_PCM_TRANSPORT, requireLivePcmTransport, requireLivePcmReply };
