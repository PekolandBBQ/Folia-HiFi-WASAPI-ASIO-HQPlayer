'use strict';
const { types } = require('node:util');
const { own, sourceErrorCode, projectEvent } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { isPreviewDiagnosticsEnabled, publishPreviewDiagnostic, previewSessionRef, previewOperationRef } = require('../debug/privatePreviewDiagnosticBus.cjs');
const { previewPlaylistRef } = require('./playlistDiagnostics.cjs');
const { reportCableSetup } = require('./cableDiagnostics.cjs');

// electron/spotify/privatePreviewObserver.cjs — observes existing calls without reading accounts or altering outcomes.
const COMMANDS = new Set('loginBegin loginImage loginCheck loginCancel status logout search playlists savedTracks song lyrics playlist playlistTracks album albumTracks audio cancelAudio configure configuration playbackSetup close resetPlayback shutdown service-create'.split(' '));
const BROWSER_COMMANDS = new Set(['begin', 'position', 'start', 'pull', 'pause', 'stop']);
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? value / 1000 : undefined;

function observeSpotifyOperation(layer, input, invoke, { lifecycle, session } = {}) {
    if (!isPreviewDiagnosticsEnabled()) return invoke();
    const action = lifecycle || own(input, 'action'), browser = layer === 'browser-service' || layer === 'browser-ipc';
    const command = browser ? BROWSER_COMMANDS.has(action) ? `browser-${action}` : 'unknown' : COMMANDS.has(action) ? action : 'unknown';
    const quiet = browser && action === 'pull';
    const rawSession = session ?? own(input, 'session') ?? (['audio', 'cancelAudio'].includes(action) ? own(input, 'requestId') : undefined);
    const fields = { layer: action === 'playbackSetup' ? 'setup' : layer, command, operationRef: previewOperationRef(),
        sessionRef: previewSessionRef(rawSession),
        playlistRef: ['playlist', 'playlistTracks'].includes(action) ? previewPlaylistRef(own(input, 'id')) : undefined,
        operation: action === 'playbackSetup' ? own(input, 'operation') : undefined,
        requestedQuality: own(input, 'quality') };
    const emit = (type, values) => { try { publishPreviewDiagnostic(type, { ...fields, ...values }); } catch {} };
    if (!quiet) emit('spotify.command', { phase: 'request' });
    function completed(ok, value) {
        if (!ok) { emit('spotify.command', { phase: 'result', ok: false, errorCode: sourceErrorCode(value) }); return; }
        if (quiet) return;
        emit('spotify.command', { phase: 'result', ok: true });
        if (layer === 'service' && action === 'playbackSetup' && own(value, 'backend') === 'vb-cable') reportCableSetup(value, fields);
        // These flags are observations of an acknowledged API result, never proof of physical device release.
        if (['close', 'resetPlayback', 'shutdown', 'logout'].includes(action) || browser && action === 'stop')
            emit('spotify.command', { phase: 'release', ok: true, releaseAcknowledged: true });
        const state = { state: own(value, 'state'), available: own(value, 'available'), playing: own(value, 'playing'),
            paused: own(value, 'paused'), stopped: own(value, 'stopped'), complete: own(value, 'complete'), changed: own(value, 'changed'),
            positionSeconds: seconds(own(value, 'positionMs')), durationSeconds: seconds(own(value, 'durationMs')),
            generation: own(value, 'generation'), outputSampleRate: browser ? own(value, 'sampleRate') : undefined,
            outputChannels: browser ? own(value, 'channels') : undefined, outputBitsPerSample: browser ? own(value, 'bitDepth') : undefined };
        const code = own(value, 'code');
        if (code !== undefined) state.errorCode = sourceErrorCode(value);
        const projected = projectEvent('spotify.state', state);
        if (projected && Object.keys(projected.fields).length) emit('spotify.state', projected.fields);
    }
    let result;
    try { result = invoke(fields); } catch (error) { completed(false, error); throw error; }
    // Keep rejection observable on the returned promise: a detached catch would suppress the app's
    // unhandled-rejection policy when a caller forgets to await. Values and error objects stay identical.
    if (types.isPromise(result)) {
        try { return Promise.prototype.then.call(result, value => { completed(true, value); return value; }, error => { completed(false, error); throw error; }); }
        catch { /* A diagnostic observer cannot change the original result. */ }
    } else completed(true, result);
    return result;
}
function observeSpotifyService(service) {
    const request = service.request, browser = service.requestBrowserPcm, close = service.close, lifecycleToken = {};
    service.request = function (...args) { return observeSpotifyOperation('service', args[0], context => Reflect.apply(request, this,
        context ? [args[0], args[1], context] : args)); };
    service.requestBrowserPcm = function (...args) { return observeSpotifyOperation('browser-service', args[0], () => Reflect.apply(browser, this, args)); };
    service.close = function (...args) { return observeSpotifyOperation('lifecycle', null, () => Reflect.apply(close, this, args), { lifecycle: 'close', session: lifecycleToken }); };
    return service;
}
module.exports = { observeSpotifyOperation, observeSpotifyService };
