import type { TFunction } from 'i18next';
import type { SignalSnapshot } from '../../stores/useSignalPathStore';

// src/components/audio/buildSignalPath.ts — report measured metadata separately from engine configuration.
export function buildSignalPath(state: SignalSnapshot | null, selected: string, t: TFunction) {
    const unknown = t('signalPath.unknown');
    const rate = state?.sourceSampleRate ? `${state.sourceSampleRate / 1000} kHz` : unknown;
    const bits = state?.sourceBitsPerSample ? `${state.sourceBitsPerSample}-bit` : '';
    const brief = state ? [rate, bits].filter(Boolean).join(' / ') : t('signalPath.preparing');
    const gain = state?.effectiveGain;
    const rows = [
        { title: t('signalPath.source'), value: [state?.sourceCodec || unknown, rate, bits].filter(Boolean).join(' · ') },
        { title: t('signalPath.processing'), value: state ? t(state.processingMode === 'integer-direct' ? 'signalPath.integer' : 'signalPath.compatibility') : unknown },
        { title: t('signalPath.conversion'), value: state?.sourceSampleRate && state.sampleRate
            ? state.sourceSampleRate === state.sampleRate ? t('signalPath.sameRate') : `${rate} → ${state.sampleRate / 1000} kHz` : unknown },
        { title: t('signalPath.format'), value: state?.outputFormat || unknown },
        { title: t('signalPath.gain'), value: gain === undefined ? unknown : gain === 0 ? '−∞ dB' : `${(20 * Math.log10(gain)).toFixed(2)} dB` },
        { title: t('signalPath.output'), value: `${state?.backend || selected}${state?.backend === 'asio' ? ` · ${state.deviceId}` : ''}` },
    ];
    return { rows, brief };
}
