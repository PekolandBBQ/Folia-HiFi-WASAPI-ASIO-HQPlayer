// DEV diagnostics carry stable operations/codes only; no private media URL is accepted here.
export function nativeRendererErrors(handoff, since) {
    if (!Number.isFinite(since)) throw new Error('Renderer error gate requires a finite stage timestamp');
    return (handoff?.events || []).filter(event => event.phase === 'native-error' && Number.isFinite(event.at) && event.at >= since)
        .map(event => {
            const [operation, code] = String(event.reason || '').split(':');
            return { at: event.at, backend: ['asio', 'wasapi-exclusive', 'hqplayer'].includes(event.backend) ? event.backend : undefined,
                position: Number.isFinite(event.position) ? event.position : undefined,
                operation: ['event', 'load', 'play', 'pause', 'seek', 'gain', 'volume', 'replaygain'].includes(operation) ? operation : 'unknown',
                code: /^[A-Z_]+$/.test(code) ? code : 'NATIVE_REQUEST_FAILED' };
        });
}
export function assertNoNativeRendererErrors(errors) {
    if (errors.length) throw new Error(`Renderer native error during playback: ${errors.map(error => `${error.operation}:${error.code}`).join(', ')}`);
}
