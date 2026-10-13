import type { NativeAudioBackend } from './nativeAudio';
import type { nativeErrorCodes } from '../services/nativeAudio/errors';

// src/types/privateDiagnostics.ts — the private, bounded diagnostic IPC contract.
export type PrivateNativeErrorCode = typeof nativeErrorCodes[number];
export type PrivateDiagnosticOperation = 'begin' | 'finish' | 'play' | 'pause' | 'seek' | 'stop'
    | 'volume' | 'replaygain' | 'gain' | 'devices' | 'status' | 'output-switch' | 'unknown';
export type OutputHandoffPhase = 'registered' | 'unregistered' | 'requested' | 'rejected' | 'captured'
    | 'cancelled' | 'discarded' | 'waiting' | 'deferred' | 'restoring' | 'restored' | 'restore-failed';
export type OutputHandoffReason = 'no-owner' | 'no-deck' | 'no-source' | 'source-mismatch'
    | 'outgoing-error-retained' | 'source-changed' | 'output-not-committed' | 'effect-replaced'
    | 'checkpoint-replaced' | 'deck-replaced' | 'deck-error' | 'metadata' | 'restore-rejected' | 'restore-aborted';
export interface OutputHandoffFields {
    phase: OutputHandoffPhase;
    operation?: 'output-switch';
    toBackend?: NativeAudioBackend;
    positionSeconds?: number;
    playing?: boolean;
    reason?: OutputHandoffReason;
    errorCode?: PrivateNativeErrorCode;
    sessionRef?: number;
}
export interface SpotifyLibraryDiagnosticFields {
    phase: 'refresh-start' | 'refresh-result' | 'hydrate' | 'cache-before' | 'cache-after' | 'cache-replace' | 'normalized-page' | 'normalized-item' | 'dedup-page';
    // Consumed by the trusted main IPC projection only. Never accepted by the journal schema.
    playlistId?: string;
    refreshRef?: number;
    source?: 'api' | 'public' | 'cache' | 'mixed' | 'unknown';
    reason?: 'success' | 'failed' | 'cancelled' | 'replaced' | 'retained' | 'removed' | 'invalid-row' | 'unknown';
    ownerSelf?: 'yes' | 'no' | 'unknown'; publicState?: 'yes' | 'no' | 'unknown'; collaborativeState?: 'yes' | 'no' | 'unknown';
    ok?: boolean; capped?: boolean; accountChanged?: boolean; revisionChanged?: boolean; hasContinuation?: boolean;
    pageOffset?: number; nextOffset?: number; rawCount?: number; normalizedCount?: number; droppedCount?: number;
    duplicateCount?: number; invalidCount?: number; nullCount?: number; inspectedCount?: number;
    beforeCount?: number; afterCount?: number; publicBeforeCount?: number; publicAfterCount?: number; removedCount?: number;
    errorCode?: string;
}
export type PrivateDiagnosticRecord =
    | { event: 'spotify.library'; fields: SpotifyLibraryDiagnosticFields }
    | { event: 'output.handoff'; fields: OutputHandoffFields }
    | { event: 'renderer.native-error'; fields: {
        operation: PrivateDiagnosticOperation; errorCode: PrivateNativeErrorCode; sessionRef?: number;
    } };
export type PauseResponseInspectionState = 'idle' | 'armed' | 'captured' | 'failed' | 'unavailable';
export interface PauseResponseInspectionResult {
    ok: boolean;
    pauseResponseInspection: PauseResponseInspectionState;
    errorCode?: 'INSPECTION_FAILED' | 'UNAVAILABLE';
}
export interface PrivateDiagnosticsStatus {
    enabled: boolean;
    available: boolean;
    recording: boolean;
    busy: boolean;
    runId?: string;
    buildRef?: string;
    recordCount: number;
    fileCount: number;
    totalBytes: number;
    maxFiles: number;
    maxFileBytes: number;
    droppedRecords: number;
    writeErrors: number;
    rejectedRecords: number;
    exportedArchives: number;
    exportErrors: number;
    errorCode?: string;
    pauseResponseInspection?: PauseResponseInspectionState;
}
export interface PrivateDiagnosticsActionResult {
    ok: boolean;
    canceled?: boolean;
    busy?: boolean;
    errorCode?: string;
}
export interface PrivateDiagnosticsApi {
    status(): Promise<PrivateDiagnosticsStatus>;
    openFolder(): Promise<PrivateDiagnosticsActionResult>;
    export(): Promise<PrivateDiagnosticsActionResult>;
    armPauseResponseInspection?(): Promise<PauseResponseInspectionResult>;
    record(record: PrivateDiagnosticRecord): void;
}
