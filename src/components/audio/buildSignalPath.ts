import { formatHQPlayerRate } from '../../utils/hqplayerRate';
import type { TFunction } from 'i18next';
import type { SignalSnapshot } from '../../stores/useSignalPathStore';

// src/components/audio/buildSignalPath.ts — report measured metadata separately from engine configuration.
export function buildSignalPath(state: SignalSnapshot | null, selected: string, t: TFunction) {
    const unknown = t('signalPath.unknown');
    const source = state?.preparedSource && state.sourceEncodingVerified === false ? null : state;
    const rate = source?.sourceSampleRate ? `${source.sourceSampleRate / 1000} kHz` : unknown;
    const bits = source?.sourceBitsPerSample ? `${source.sourceBitsPerSample}-bit` : '';
    const bitrate = source?.sourceBitrate ? `${Math.round(source.sourceBitrate / 1000)} kbps` : '';
    const prepared = state?.preparedAudio;
    const preparedRate = prepared?.sampleRate ? `${prepared.sampleRate / 1000} kHz` : '';
    const preparedBits = prepared?.bitDepth ? `${prepared.bitDepth}-bit` : '';
    const preparedFormat = prepared ? [prepared.representation, preparedRate, preparedBits,
        prepared.channels ? `${prepared.channels} ch` : ''].filter(Boolean).join(' · ') : '';
    const brief = !state ? t('signalPath.preparing') : !source?.sourceSampleRate && preparedRate
        ? `${t('signalPath.prepared')} · ${[preparedRate, preparedBits].filter(Boolean).join(' / ')}`
        : [rate, bits].filter(Boolean).join(' / ');
    const gain = state?.effectiveGain;
    const hq = (state?.backend || selected) === 'hqplayer';
    const browser = (state?.backend || selected) === 'browser';
    const outputKnown = (!hq && !browser) || state?.outputRateReported === true;
    const inputRate = prepared?.sampleRate || source?.sourceSampleRate;
    const sourceDsd = !prepared && /DSD|DSF|DFF/i.test(source?.sourceCodec || '');
    const outputMode = state?.outputMode || state?.outputFormat?.split(' · ')[0] || '';
    const outputDsd = /DSD|SDM/i.test(outputMode);
    const format = (hz: number, dsd: boolean) => {
        if (!dsd) return `PCM ${hz / 1000} kHz`;
        const multiplier = formatHQPlayerRate(hz, true).match(/x(\d+)$/)?.[1];
        return multiplier ? `DSD ${multiplier}` : `DSD ${hz / 1000000} MHz`;
    };
    const spotifyCapture = state?.sourceOrigin === 'spotify-process';
    const rows = [
        { title: t('signalPath.source'), value: state?.preparedSource && !source?.sourceCodec && !source?.sourceSampleRate && !bits && !bitrate
            ? t('signalPath.originalUnknown') : [source?.sourceCodec || unknown, rate, bits, bitrate].filter(Boolean).join(' · ') },
        ...(prepared ? [{ title: t('signalPath.prepared'), value: preparedFormat }] : []),
        ...(spotifyCapture ? [{ title: t('signalPath.captureSource'), value: t('signalPath.spotifyProcessSource') }] : []),
        ...(state?.hqplayerInputContainer === 'wav' ? [{ title: t('signalPath.hqInput'), value: `WAV · ${preparedFormat}` }] : []),
        { title: t('signalPath.processing'), value: state ? hq ? t('signalPath.hqProcessing') : browser ? t('signalPath.browserProcessing') : t(state.processingMode === 'integer-direct' ? 'signalPath.integer' : state.streaming ? 'signalPath.streamingCompatibility' : 'signalPath.compatibility') : unknown },
        { title: t(prepared ? 'signalPath.preparedConversion' : 'signalPath.conversion'), value: outputKnown && inputRate && state?.sampleRate
            ? `${format(inputRate, sourceDsd)} → ${format(state.sampleRate, outputDsd)}` : unknown },
        { title: t('signalPath.format'), value: outputKnown ? browser && state?.outputFormat && state.sampleRate
            ? `${state.outputFormat} · ${state.sampleRate / 1000} kHz` : state?.outputFormat || unknown : unknown },
        { title: t('signalPath.gain'), value: hq ? state?.volumeDb === undefined ? unknown : `${state.volumeDb.toFixed(1)} dB` : gain === undefined ? unknown : gain === 0 ? '−∞ dB' : `${(20 * Math.log10(gain)).toFixed(2)} dB` },
        { title: t('signalPath.output'), value: browser ? t('signalPath.browser') : `${state?.backend || selected}${state?.backend === 'asio' ? ` · ${state.deviceId}` : ''}` },
    ];
    if (state?.requestedQuality || state?.sourceQuality || state?.sourceProviderLevel || state?.preparedSource) {
        const requested = state.requestedQuality ? t(`signalPath.qualities.${state.requestedQuality}`) : unknown;
        const actual = state.sourceQuality ? t(`signalPath.qualities.${state.sourceQuality}`)
            : spotifyCapture ? t('signalPath.spotifyQualityUnreported')
            : state.sourceProviderLevel ? `${unknown} (${state.sourceProviderLevel})` : unknown;
        rows.splice(1, 0, { title: t('signalPath.streamingQuality'),
            value: spotifyCapture ? `${t('signalPath.returnedQuality')}: ${actual}`
                : `${t('signalPath.requestedQuality')}: ${requested} · ${t('signalPath.returnedQuality')}: ${actual}` });
    }
    return { rows, brief };
}
