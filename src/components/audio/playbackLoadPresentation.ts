import type { TFunction } from 'i18next';
import type { LoadProgress } from '../../stores/usePlaybackLoadStore';

// Describe measured preparation work without inventing a percentage for unmeasured stages.
export function describePlaybackLoad(progress: LoadProgress, elapsedMs: number, t: TFunction) {
    const measured = progress.loaded !== undefined && Number.isFinite(progress.loaded) && progress.loaded >= 0;
    const hasTotal = progress.total !== undefined && Number.isFinite(progress.total) && progress.total > 0;
    const percent = measured && hasTotal ? Math.min(100, progress.loaded! / progress.total! * 100) : undefined;
    const amount = (value: number) => progress.unit === 'milliseconds'
        ? t('loadProgress.seconds', { value: (value / 1000).toFixed(value < 1000 ? 2 : value < 10000 ? 1 : 0) })
        : progress.unit === 'items' ? t('loadProgress.items', { value: Math.round(value) })
        : t('loadProgress.megabytes', { value: (value / 1048576).toFixed(1) });
    const completion = measured ? hasTotal
        ? `${amount(progress.loaded!)} / ${amount(progress.total!)}` : amount(progress.loaded!)
        : t('loadProgress.unmeasured');
    const elapsed = t('loadProgress.seconds', { value: (Math.max(0, elapsedMs, progress.elapsedMs || 0) / 1000).toFixed(0) });
    return { percent, completion, elapsed,
        stage: t(`loadProgress.${progress.stage}`),
        reason: t(`loadProgress.reasons.${progress.stage}`) };
}
