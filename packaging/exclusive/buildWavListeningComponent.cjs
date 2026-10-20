const fs = require('node:fs');
const path = require('node:path');
const { unzipSync } = require('fflate');

// packaging/exclusive/buildWavListeningComponent.cjs — narrow listening overlay on the exact bundled shipping worker.
function patchWavWorker(source) {
    const replace = (before, after) => {
        if (source.split(before).length !== 2) throw new Error('WAV candidate baseline does not match the expected shipping source');
        source = source.replace(before, after);
    };
    replace('function createHQPlayerStreaming({ host, onError = () => {}, sourceFactory',
        'function createHQPlayerStreaming({ host, onError = () => {}, onDiagnostic = () => {}, sourceFactory');
    replace('sourceFactory = (settings) => new PcmLoopbackSource(settings)',
        'sourceFactory = (settings) => settings.foliaWav ? new (require("./wavPcmSource.cjs").createWavPcmSource(PcmLoopbackSource))(settings) : new PcmLoopbackSource(settings)');
    replace('bufferSeconds: 6\n', 'bufferSeconds: 6, foliaWav: spec.transport !== void 0, onDiagnostic: ((streamGeneration) => (detail) => onDiagnostic({ ...detail, session: spec.session, streamGeneration }))(generation + 1)\n');
    replace('streaming = createHQPlayerStreaming({\n\t\t\t\thost,',
        'streaming = createHQPlayerStreaming({\n\t\t\t\thost, onDiagnostic: (detail) => send({ event: "diagnostic", detail }),');
    replace('bufferCapacityBytes: record.source.state.capacityBytes,',
        'bufferCapacityBytes: record.source.state.capacityBytes, inputContainer: record.source.inputContainer,');
    replace('const tailFrames = Math.ceil((Math.min(3, latency) + .25) * record.spec.sampleRate);',
        'const tailFrames = Math.ceil(((record.source.inputContainer === "wav" ? latency : Math.min(3, latency)) + .25) * record.spec.sampleRate);\n'
        + '\t\t\t\tif (record.source.inputContainer === "wav") onDiagnostic({ event: "wav-http", phase: "pcm-input-complete", session: record.session, streamGeneration: record.generation, '
        + 'capturedFrames: record.decodedFrames, inputEndSeconds: (record.spec.position0 || 0) + record.decodedFrames / record.spec.sampleRate, '
        + 'reportedOutputDelaySeconds: latency, flushFrames: tailFrames, action: "drain-http-and-dsp-before-output-ended" });');
    return source;
}
function buildWavListeningComponent({ archive, destination }) {
    if (fs.existsSync(destination)) throw new Error('WAV component destination already exists');
    const files = unzipSync(fs.readFileSync(archive));
    const entry = 'hqplayer-component.cjs';
    if (!files[entry]) throw new Error('Shipping HQPlayer worker is absent');
    const patched = patchWavWorker(Buffer.from(files[entry]).toString('utf8'));
    fs.mkdirSync(destination, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
        if (!/^(?:hqplayer-component\.cjs|component\.json|LICENSE\.txt|NOTICE\.txt|folia-hqplayer-launch\.exe|folia-hqplayer-window\.dll|Detours-LICENSE\.txt)$/.test(name))
            throw new Error('Unexpected HQPlayer archive member');
        fs.writeFileSync(path.join(destination, name), name === entry ? patched : data);
    }
    for (const name of ['wavPcmSource.cjs', 'wavReplayStore.cjs', 'wavHttpRange.cjs', 'wavHeader.cjs', 'wavHttpAddress.cjs'])
        fs.copyFileSync(path.resolve(__dirname, '../../electron/hqplayer', name), path.join(destination, name));
    return { executable: path.join(destination, entry), container: 'wav', originalComponent: '0.1.4-preview.7', pcmUnchanged: true };
}
module.exports = { patchWavWorker, buildWavListeningComponent };
