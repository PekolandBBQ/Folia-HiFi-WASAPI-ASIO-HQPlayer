import type { PrivateDiagnosticOperation, PrivateDiagnosticRecord, PrivateDiagnosticsApi } from '../../types/privateDiagnostics';
import { getNativeErrorCode, type nativeErrorCodes } from '../nativeAudio/errors';

// src/services/debug/privateDiagnostics.ts — diagnostics never change playback or expose raw errors.
export function getPrivateDiagnosticsApi(): PrivateDiagnosticsApi | undefined {
    if (typeof window === 'undefined' || window.electron?.privatePreview !== true) return undefined;
    return window.electron.privateDiagnostics;
}

export function recordPrivateDiagnostic(record: PrivateDiagnosticRecord) {
    try { getPrivateDiagnosticsApi()?.record(record); } catch { /* A closing diagnostic bridge cannot fail playback. */ }
}

let nextReference = 0;
export function nextPrivateDiagnosticRef() {
    nextReference = nextReference >= 2147483647 ? 1 : nextReference + 1;
    return nextReference;
}

const OPERATIONS = new Set<PrivateDiagnosticOperation>(['begin', 'finish', 'play', 'pause', 'seek', 'stop',
    'volume', 'replaygain', 'gain', 'devices', 'status', 'output-switch', 'unknown']);
export function recordPrivateNativeError(operation: string, error: unknown, sessionRef?: number) {
    recordPrivateDiagnostic({ event: 'renderer.native-error', fields: {
        operation: OPERATIONS.has(operation as PrivateDiagnosticOperation) ? operation as PrivateDiagnosticOperation : 'unknown',
        errorCode: getNativeErrorCode(error) as typeof nativeErrorCodes[number],
        ...(Number.isSafeInteger(sessionRef) && sessionRef! > 0 && sessionRef! <= 2147483647 ? { sessionRef } : {}),
    } });
}
