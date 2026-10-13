import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHQPlayerSettingsStore } from '../../stores/useHQPlayerSettingsStore';
import { HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS, HQPLAYER_SPOTIFY_STARTUP_DELAY_RANGE, normalizeHQPlayerSpotifyExperiment } from '../../utils/hqplayerSpotifyExperiment';

// src/components/audio/HQPlayerSpotifyExperimentSettings.tsx — explicit, session-only Spotify live PCM opt-in and next-load tuning.
function ExperimentMilliseconds({ field, value, disabled, onChange }: {
    field: 'startupDelayMs'; value: number; disabled: boolean; onChange: (value: number) => void;
}) {
    const { t } = useTranslation();
    const id = useId();
    const [draft, setDraft] = useState(String(value));
    const range = HQPLAYER_SPOTIFY_STARTUP_DELAY_RANGE;
    useEffect(() => { setDraft(String(value)); }, [value, disabled]);
    const commit = (input: HTMLInputElement) => {
        const normalized = normalizeHQPlayerSpotifyExperiment({ [field]: input.valueAsNumber })[field];
        setDraft(String(normalized)); onChange(normalized);
    };
    return <div className="mt-3">
        <label htmlFor={id} className="flex items-center justify-between gap-4 text-sm">
            <span>{t(`hqpSpotifyExperiment.${field}`)}</span>
            <input id={id} type="number" min={range.min} max={range.max} step={range.step} value={draft}
                disabled={disabled} aria-describedby={`${id}-range`} inputMode="numeric"
                className="w-28 shrink-0 rounded-lg border bg-transparent px-2 py-1 disabled:opacity-40"
                onChange={event => setDraft(event.target.value)} onBlur={event => commit(event.currentTarget)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget); } }} />
        </label>
        <p id={`${id}-range`} className="mt-1 text-xs opacity-70">{t('hqpSpotifyExperiment.range', {
            min: range.min, max: range.max, default: HQPLAYER_SPOTIFY_EXPERIMENT_DEFAULTS[field],
        })}</p>
    </div>;
}

export default function HQPlayerSpotifyExperimentSettings() {
    const { t } = useTranslation();
    const id = useId();
    const experiment = useHQPlayerSettingsStore(state => state.spotifyExperiment);
    const setExperiment = useHQPlayerSettingsStore(state => state.setSpotifyExperiment);
    const reset = useHQPlayerSettingsStore(state => state.resetSpotifyExperiment);
    return <div role="group" aria-labelledby={`${id}-title`} className="my-4 border-t border-current/15 pt-4" data-testid="hqplayer-spotify-experiment">
        <h3 id={`${id}-title`} className="text-sm font-semibold">{t('hqpSpotifyExperiment.title')}</h3>
        <p id={`${id}-warning`} className="mt-2 text-xs leading-relaxed">{t('hqpSpotifyExperiment.warning')}</p>
        <label className="mt-3 flex items-start gap-3 text-sm">
            <input type="checkbox" checked={experiment.enabled} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-color)]"
                aria-describedby={`${id}-warning ${id}-apply`}
                onChange={event => setExperiment({ enabled: event.target.checked })} />
            <span>{t('hqpSpotifyExperiment.enable')}</span>
        </label>
        <p className="mt-3 text-xs leading-relaxed">{t('livePcmPrebuffer.sharedHint')}</p>
        <ExperimentMilliseconds field="startupDelayMs" value={experiment.startupDelayMs} disabled={!experiment.enabled}
            onChange={startupDelayMs => setExperiment({ startupDelayMs })} />
        <p className="mt-2 text-xs leading-relaxed opacity-70">{t('hqpSpotifyExperiment.delayDescription')}</p>
        <p id={`${id}-apply`} className="mt-2 text-xs leading-relaxed opacity-70">{t('hqpSpotifyExperiment.applyDescription')}</p>
        <button type="button" className="mt-3 rounded-lg border px-3 py-2 text-sm" onClick={reset}>
            {t('hqpSpotifyExperiment.reset')}
        </button>
    </div>;
}
