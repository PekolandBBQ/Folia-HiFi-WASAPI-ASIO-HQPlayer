import React from 'react';
import { Activity, Download, FolderOpen, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PrivateDiagnosticsApi } from '../../../types/privateDiagnostics';
import { usePrivateDiagnostics } from '../../../hooks/usePrivateDiagnostics';

// src/components/modal/settings/PrivateDiagnosticsSection.tsx — local-only private preview evidence controls.
export default function PrivateDiagnosticsSection({ api, isDaylight, settingsCardClass }: {
    api: PrivateDiagnosticsApi; isDaylight: boolean; settingsCardClass: string;
}) {
    const { t } = useTranslation();
    const { status, statusFailed, action, outcome, inspection, inspectionPending, canArmInspection, run } = usePrivateDiagnostics(api);
    const disabled = Boolean(action || inspectionPending || status?.busy || (status && !status.available));
    const number = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
    const outcomeKeys = { opened: 'privateDiagnosticsOpened', exported: 'privateDiagnosticsExported',
        canceled: 'privateDiagnosticsCanceled', busy: 'privateDiagnosticsBusy', failed: 'privateDiagnosticsFailed' } as const;
    const inspectionKeys = { idle: 'privateDiagnosticsInspectionIdle', armed: 'privateDiagnosticsInspectionArmed',
        captured: 'privateDiagnosticsInspectionCaptured', failed: 'privateDiagnosticsInspectionFailed', unavailable: 'privateDiagnosticsInspectionUnavailable' } as const;
    const buttonClass = `inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-40 ${isDaylight
        ? 'border-black/10 hover:bg-black/[0.05]' : 'border-white/10 hover:bg-white/[0.07]'}`;

    return <div data-testid="private-diagnostics" className={`rounded-2xl border p-4 space-y-4 ${settingsCardClass}`}>
        <div className="flex items-start gap-3">
            <Activity size={16} className="mt-1 shrink-0 opacity-60" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
                <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('options.privateDiagnosticsTitle')}</h3>
                <p className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>{t('options.privateDiagnosticsDescription')}</p>
            </div>
        </div>
        <div className={`rounded-xl border p-3 space-y-2 text-xs ${isDaylight ? 'border-black/10 bg-black/[0.03]' : 'border-white/10 bg-black/15'}`}>
            <p role="status" aria-label={t('options.privateDiagnosticsStatusLabel')} aria-live="polite">
                {t(`options.${statusFailed ? 'privateDiagnosticsStatusFailed' : !status ? 'privateDiagnosticsLoading'
                    : status.recording && status.enabled ? 'privateDiagnosticsRecording' : 'privateDiagnosticsUnavailable'}`)}
            </p>
            {status && <>
                <p className="tabular-nums opacity-65">{t('options.privateDiagnosticsCounts', {
                    records: number(status.recordCount), writeErrors: number(status.writeErrors), dropped: number(status.droppedRecords),
                })}</p>
                <p className="tabular-nums opacity-65">{t('options.privateDiagnosticsExports', {
                    exports: number(status.exportedArchives), errors: number(status.exportErrors), rejected: number(status.rejectedRecords),
                })}</p>
                <p className="tabular-nums opacity-65">{t('options.privateDiagnosticsRetention', {
                    files: number(status.maxFiles), size: number(status.maxFileBytes) / 1048576,
                    total: number(status.maxFiles) * number(status.maxFileBytes) / 1048576,
                })}</p>
            </>}
        </div>
        <p className="text-xs leading-relaxed opacity-60" style={{ color: 'var(--text-secondary)' }}>
            {t('options.privateDiagnosticsPrivacy')} {' '}{t('options.privateDiagnosticsNoUpload')}
        </p>
        <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={disabled} onClick={() => void run('openFolder')}>
                {action === 'openFolder' ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <FolderOpen size={13} aria-hidden="true" />}
                {t('options.privateDiagnosticsOpen')}
            </button>
            <button type="button" className={buttonClass} disabled={disabled} onClick={() => void run('export')}>
                {action === 'export' ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
                {t('options.privateDiagnosticsExport')}
            </button>
        </div>
        <p role="status" aria-label={t('options.privateDiagnosticsActionLabel')} aria-live="polite" className="min-h-4 text-xs opacity-70">
            {action || inspectionPending || status?.busy ? t('options.privateDiagnosticsBusy') : outcome ? t(`options.${outcomeKeys[outcome]}`) : ''}
        </p>
        <div className={`rounded-xl border p-3 space-y-3 text-xs ${isDaylight ? 'border-black/10 bg-black/[0.03]' : 'border-white/10 bg-black/15'}`}>
            <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('options.privateDiagnosticsInspectionTitle')}</h4>
            <p id="pause-response-inspection-description" className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {t('options.privateDiagnosticsInspectionDescription')}
            </p>
            <p role="status" aria-label={t('options.privateDiagnosticsInspectionStatusLabel')} aria-live="polite"
                style={{ color: 'var(--text-primary)' }}>
                {inspection === 'captured' || inspection === 'failed' ? t(`options.${inspectionKeys[inspection]}`)
                    : inspectionPending ? t('options.privateDiagnosticsInspectionPreparing')
                    : statusFailed ? t('options.privateDiagnosticsInspectionStatusFailed')
                    : inspection ? t(`options.${inspectionKeys[inspection]}`) : t('options.privateDiagnosticsLoading')}
            </p>
            <button type="button" className={buttonClass} style={{ color: 'var(--text-primary)' }}
                aria-describedby="pause-response-inspection-description" disabled={disabled || !canArmInspection}
                onClick={() => void run('armPauseResponseInspection')}>
                {inspectionPending && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {t('options.privateDiagnosticsInspectionArm')}
            </button>
        </div>
    </div>;
}
