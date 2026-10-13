import { useCallback, useEffect, useRef, useState } from 'react';
import type { PauseResponseInspectionState, PrivateDiagnosticsApi, PrivateDiagnosticsStatus } from '../types/privateDiagnostics';

// src/hooks/usePrivateDiagnostics.ts — fence repeated actions and results from a closed settings view.
export type PrivateDiagnosticAction = 'openFolder' | 'export' | 'armPauseResponseInspection';
export type PrivateDiagnosticOutcome = 'opened' | 'exported' | 'canceled' | 'busy' | 'failed' | null;
type InspectionSession = { attempted: boolean; pending: boolean; state: PauseResponseInspectionState | null; revision: number };
// A stable preload bridge retains the one-click fence across settings close/reopen, never on disk.
const inspectionSessions = new WeakMap<PrivateDiagnosticsApi, InspectionSession>();
function inspectionState(value: unknown): PauseResponseInspectionState {
    return value === 'idle' || value === 'armed' || value === 'captured' || value === 'failed' ? value : 'unavailable';
}
function updateInspection(session: InspectionSession, next: PauseResponseInspectionState) {
    if (session.state === 'captured' || session.state === 'failed' || (next === 'idle' && session.attempted)) return;
    session.state = next;
}
export function usePrivateDiagnostics(api: PrivateDiagnosticsApi) {
    if (!inspectionSessions.has(api)) inspectionSessions.set(api, { attempted: false, pending: false, state: null, revision: 0 });
    const session = inspectionSessions.get(api)!;
    const [status, setStatus] = useState<PrivateDiagnosticsStatus | null>(null);
    const [statusFailed, setStatusFailed] = useState(false);
    const [action, setAction] = useState<PrivateDiagnosticAction | null>(null);
    const [outcome, setOutcome] = useState<PrivateDiagnosticOutcome>(null);
    const [inspection, setInspection] = useState(session.state);
    const [inspectionPending, setInspectionPending] = useState(session.pending);
    const mounted = useRef(false);
    const generation = useRef(0);
    const busy = useRef(false);
    const reading = useRef(false);

    const refresh = useCallback(async () => {
        if (reading.current || !mounted.current) return;
        const token = generation.current;
        const revision = session.revision;
        reading.current = true;
        try {
            const next = await api.status();
            if (mounted.current && token === generation.current) {
                setStatus(next); setStatusFailed(false);
                // A pre-click poll must not overwrite the result of the one-time action.
                if (revision === session.revision) {
                    const state = typeof api.armPauseResponseInspection === 'function'
                        ? inspectionState(next.pauseResponseInspection) : 'unavailable';
                    updateInspection(session, state);
                }
            }
        } catch {
            if (mounted.current && token === generation.current) setStatusFailed(true);
        } finally {
            if (token === generation.current) {
                reading.current = false;
                if (mounted.current) { setInspection(session.state); setInspectionPending(session.pending); }
            }
        }
    }, [api, session]);

    useEffect(() => {
        mounted.current = true;
        generation.current++;
        reading.current = false;
        busy.current = false;
        void refresh();
        const timer = setInterval(() => void refresh(), 3000);
        return () => { mounted.current = false; generation.current++; clearInterval(timer); };
    }, [refresh]);

    // Set the ref before awaiting or rendering: two clicks in the same frame still create one dialog.
    const run = useCallback(async (next: PrivateDiagnosticAction) => {
        if (!mounted.current || busy.current || session.pending || status?.busy) return;
        const arm = next === 'armPauseResponseInspection';
        if (arm && (session.attempted || statusFailed || !status?.enabled || !status.available
            || session.state !== 'idle' || typeof api.armPauseResponseInspection !== 'function')) return;
        const token = generation.current;
        busy.current = true;
        setAction(next); setOutcome(null);
        if (arm) {
            session.attempted = true; session.pending = true; session.revision++;
            setInspectionPending(true);
        }
        try {
            if (arm) {
                const result = await api.armPauseResponseInspection!();
                const state = inspectionState(result?.pauseResponseInspection);
                updateInspection(session, state === 'idle' ? 'unavailable' : state);
            } else {
                const result = await api[next]();
                if (mounted.current && token === generation.current) {
                    setOutcome(result?.busy ? 'busy' : result?.canceled ? 'canceled'
                        : result?.ok ? next === 'export' ? 'exported' : 'opened' : 'failed');
                }
            }
        } catch {
            if (arm) updateInspection(session, 'unavailable');
            else if (mounted.current && token === generation.current) setOutcome('failed');
        } finally {
            if (arm) { session.pending = false; session.revision++; }
            if (mounted.current && token === generation.current) {
                setInspection(session.state); setInspectionPending(session.pending);
                busy.current = false; setAction(null); void refresh();
            }
        }
    }, [api, refresh, session, status, statusFailed]);

    const canArmInspection = Boolean(status?.enabled && status.available && !statusFailed && !status.busy
        && inspection === 'idle' && !session.attempted && !inspectionPending && typeof api.armPauseResponseInspection === 'function');
    return { status, statusFailed, action, outcome, inspection, inspectionPending, canArmInspection, run };
}
