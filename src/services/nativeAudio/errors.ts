// src/services/nativeAudio/errors.ts — public error codes never interpolate engine diagnostics.
export const nativeErrorCodes = ['COMPONENT_CRASHED', 'COMPONENT_TIMEOUT', 'COMPONENT_UNAVAILABLE',
    'COMPONENT_INTEGRITY', 'COMPONENT_INCOMPATIBLE', 'COMPONENT_UPDATE_FAILED', 'ROLLBACK_UNAVAILABLE',
    'SOURCE_UNAVAILABLE', 'SOURCE_EXPIRED', 'SOURCE_TOO_LARGE', 'DECODE_FAILED', 'DEVICE_UNAVAILABLE',
    'FORMAT_UNSUPPORTED', 'INVALID_REQUEST', 'CANCELLED', 'NATIVE_REQUEST_FAILED'] as const;
export function getNativeErrorCode(error: unknown): string {
    const value = error as { code?: unknown; message?: unknown; nativeCode?: unknown } | null;
    return nativeErrorCodes.find(code => code === value?.nativeCode || code === value?.code || code === value?.message) || 'NATIVE_REQUEST_FAILED';
}
export const nativeErrorKey = (error: unknown) => `nativeAudio.errors.${getNativeErrorCode(error)}`;
