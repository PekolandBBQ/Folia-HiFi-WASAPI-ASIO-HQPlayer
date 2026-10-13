import type { NativeAudioState } from '../../types/nativeAudio';

// src/services/nativeAudio/streamingMediaState.ts — expose only PCM that the streaming helper has buffered.
export type NativeBufferState = { streaming: boolean; buffering: boolean; start: number; end: number; complete: boolean };

export function readNativeBufferState(state: NativeAudioState): NativeBufferState {
    const limit = Number.isFinite(state.duration) && state.duration > 0 ? state.duration : Infinity;
    const start = Math.min(limit, Math.max(0, Number.isFinite(state.bufferedStart) ? state.bufferedStart! : state.position));
    const end = Math.min(limit, Math.max(start, Number.isFinite(state.bufferedEnd) ? state.bufferedEnd! : start));
    return { streaming: state.streaming === true, buffering: state.buffering === true,
        start, end, complete: state.producerComplete === true };
}

export function streamingReadyState(buffer: NativeBufferState, position: number, duration: number): number {
    if (buffer.buffering || buffer.end <= position) return 2;
    return buffer.complete && Number.isFinite(duration) && buffer.end >= duration - 0.001 ? 4 : 3;
}

export function mediaTimeRange(start: number, end: number, enabled = true): TimeRanges {
    const present = enabled && Number.isFinite(start) && Number.isFinite(end) && end > start;
    const check = (index: number) => {
        if (!present || index !== 0) throw new DOMException('No buffered range at this index', 'IndexSizeError');
    };
    return { length: present ? 1 : 0,
        start: index => { check(index); return start; }, end: index => { check(index); return end; } };
}
