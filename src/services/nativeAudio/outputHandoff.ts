import type { NativeAudioBackend } from '../../types/nativeAudio';
import type { OutputHandoffPhase, OutputHandoffReason, PrivateNativeErrorCode } from '../../types/privateDiagnostics';
import { recordPrivateDiagnostic } from '../debug/privateDiagnostics';
import { getNativeErrorCode } from './errors';

// src/services/nativeAudio/outputHandoff.ts — the settings store requests; the player owns the deck.
type Prepare = (backend: NativeAudioBackend, deviceId: string) => () => void;
let prepare: Prepare | null = null;
let deferPreparation: ((source: string) => boolean) | null = null;
export const shouldDeferOutputPreparation = (source: string) => deferPreparation?.(source) === true;
type HandoffDiagnostic = { at: number; phase: OutputHandoffPhase; backend?: NativeAudioBackend; position?: number;
    playing?: boolean; reason?: OutputHandoffReason; errorCode?: PrivateNativeErrorCode; sessionRef?: number };
const diagnostics: HandoffDiagnostic[] = [];
const PHASES = new Set<OutputHandoffPhase>(['registered', 'unregistered', 'requested', 'rejected', 'captured',
    'cancelled', 'discarded', 'waiting', 'deferred', 'restoring', 'restored', 'restore-failed']);
const REASONS = new Set<OutputHandoffReason>(['no-owner', 'no-deck', 'no-source', 'source-mismatch',
    'outgoing-error-retained', 'source-changed', 'output-not-committed', 'effect-replaced', 'checkpoint-replaced',
    'deck-replaced', 'deck-error', 'metadata', 'restore-rejected', 'restore-aborted']);
const BACKENDS = new Set<NativeAudioBackend>(['browser', 'wasapi-exclusive', 'asio', 'hqplayer']);

// Project each field explicitly: neither the local probe nor IPC can acquire a source URL or device ID.
export function recordOutputHandoff(phase: OutputHandoffPhase, values: Omit<HandoffDiagnostic, 'at' | 'phase'> = {}) {
    if (!PHASES.has(phase)) return;
    const safe: Omit<HandoffDiagnostic, 'at' | 'phase'> = {};
    if (values.backend && BACKENDS.has(values.backend)) safe.backend = values.backend;
    if (typeof values.position === 'number' && Number.isFinite(values.position) && values.position >= 0 && values.position <= 604800) safe.position = values.position;
    if (typeof values.playing === 'boolean') safe.playing = values.playing;
    if (values.reason && REASONS.has(values.reason)) safe.reason = values.reason;
    if (values.errorCode) safe.errorCode = getNativeErrorCode({ code: values.errorCode }) as PrivateNativeErrorCode;
    if (Number.isSafeInteger(values.sessionRef) && values.sessionRef! > 0 && values.sessionRef! <= 2147483647) safe.sessionRef = values.sessionRef;
    recordPrivateDiagnostic({ event: 'output.handoff', fields: {
        phase, operation: 'output-switch',
        ...(safe.backend ? { toBackend: safe.backend } : {}),
        ...(safe.position !== undefined ? { positionSeconds: safe.position } : {}),
        ...(safe.playing !== undefined ? { playing: safe.playing } : {}),
        ...(safe.reason ? { reason: safe.reason } : {}),
        ...(safe.errorCode ? { errorCode: safe.errorCode } : {}),
        ...(safe.sessionRef ? { sessionRef: safe.sessionRef } : {}),
    } });
    if (!import.meta.env.DEV) return;
    diagnostics.push({ at: performance.now(), phase, ...safe });
    if (diagnostics.length > 100) diagnostics.shift();
}
export const readOutputHandoffDiagnostics = () => ({ registered: Boolean(prepare), events: diagnostics.slice() });
export function registerOutputHandoff(handler: Prepare, defer?: (source: string) => boolean) {
    prepare = handler;
    deferPreparation = defer || null;
    recordOutputHandoff('registered');
    return () => { if (prepare === handler) { prepare = null; deferPreparation = null; recordOutputHandoff('unregistered'); } };
}
export const prepareOutputHandoff: Prepare = (backend, deviceId) => {
    recordOutputHandoff('requested', { backend, reason: prepare ? undefined : 'no-owner' });
    return prepare?.(backend, deviceId) || (() => {});
};
