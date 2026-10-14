import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { LIVE_PCM_PREBUFFER_RANGE } from '../../utils/livePcmPrebuffer';

// src/components/audio/LivePcmPrebufferSetting.tsx — persisted next-preparation timing, never a playback action.
export default function LivePcmPrebufferSetting({ disabled = false }: { disabled?: boolean }) {
    const { t } = useTranslation();
    const id = useId();
    const value = useAudioSettingsStore(state => state.livePcmPrebufferMs);
    const setValue = useAudioSettingsStore(state => state.handleSetLivePcmPrebufferMs);
    return <div className="mt-4 border-t border-current/15 pt-4" data-testid="live-pcm-prebuffer">
        <div className="flex items-center justify-between gap-4 text-sm">
            <label htmlFor={id} className="font-medium">{t('livePcmPrebuffer.title')}</label>
            <output htmlFor={id} className="shrink-0 tabular-nums">{value} ms</output>
        </div>
        <input id={id} type="range" min={LIVE_PCM_PREBUFFER_RANGE.min} max={LIVE_PCM_PREBUFFER_RANGE.max}
            step={LIVE_PCM_PREBUFFER_RANGE.step} value={value} disabled={disabled}
            aria-valuetext={`${value} ms`} aria-describedby={`${id}-hint`}
            className="mt-3 h-6 w-full cursor-pointer accent-[var(--accent-color)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-60"
            onChange={event => setValue(event.currentTarget.valueAsNumber)} />
        <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)' }}><span>25 ms</span><span>5000 ms</span></div>
        <p id={`${id}-hint`} className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {t('livePcmPrebuffer.description')}
        </p>
    </div>;
}
