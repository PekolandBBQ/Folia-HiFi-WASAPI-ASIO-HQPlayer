import { formatHQPlayerRate } from '../../utils/hqplayerRate';
import type { TFunction } from 'i18next';
import type { SignalSnapshot } from '../../stores/useSignalPathStore';

// src/components/audio/buildSignalPath.ts — report measured metadata separately from engine configuration.
export function buildSignalPath(state: SignalSnapshot | null, selected: string, t: TFunction) {
    const unknown = t('signalPath.unknown');
    const rate = state?.sourceSampleRate ? `${state.sourceSampleRate / 1000} kHz` : unknown;
    const bits = state?.sourceBitsPerSample ? `${state.sourceBitsPerSample}-bit` : '';
    const brief = state ? [rate, bits].filter(Boolean).join(' / ') : t('signalPath.preparing');
    const gain = state?.effectiveGain;
    const hq = (state?.backend || selected) === 'hqplayer';
    const outputKnown = !hq || state?.outputRateReported === true;
    const sourceDsd = /DSD|DSF|DFF/i.test(state?.sourceCodec || '');
    const outputMode = state?.outputMode || state?.outputFormat?.split(' · ')[0] || '';
    const outputDsd = /DSD|SDM/i.test(outputMode);
    const format = (hz: number, dsd: boolean) => {
        if (!dsd) return `PCM ${hz / 1000} kHz`;
        const multiplier = formatHQPlayerRate(hz, true).match(/x(\d+)$/)?.[1];
        return multiplier ? `DSD ${multiplier}` : `DSD ${hz / 1000000} MHz`;
    };
    const rows = [
        { title: t('signalPath.source'), value: [state?.sourceCodec || unknown, rate, bits].filter(Boolean).join(' · ') },
        { title: t('signalPath.processing'), value: state ? hq ? t('signalPath.hqProcessing') : t(state.processingMode === 'integer-direct' ? 'signalPath.integer' : 'signalPath.compatibility') : unknown },
        { title: t('signalPath.conversion'), value: outputKnown && state?.sourceSampleRate && state.sampleRate
            ? `${format(state.sourceSampleRate, sourceDsd)} → ${format(state.sampleRate, outputDsd)}` : unknown },
        { title: t('signalPath.format'), value: outputKnown ? state?.outputFormat || unknown : unknown },
        { title: t('signalPath.gain'), value: hq ? state?.volumeDb === undefined ? unknown : `${state.volumeDb.toFixed(1)} dB` : gain === undefined ? unknown : gain === 0 ? '−∞ dB' : `${(20 * Math.log10(gain)).toFixed(2)} dB` },
        { title: t('signalPath.output'), value: `${state?.backend || selected}${state?.backend === 'asio' ? ` · ${state.deviceId}` : ''}` },
    ];
    return { rows, brief };
}
