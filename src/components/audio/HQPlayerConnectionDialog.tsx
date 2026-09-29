import { useTranslation } from 'react-i18next';
import { useHQPlayerConnectionStore } from '../../stores/useHQPlayerConnectionStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';

// An explicit yes/no choice before Folia attaches to a manually launched Desktop instance.
export default function HQPlayerConnectionDialog() {
    const { t } = useTranslation();
    const prompt = useHQPlayerConnectionStore(state => state.prompt);
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    if (!prompt) return null;
    return <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-6" onKeyDown={event => { if (event.key === 'Escape') prompt.choose(false); }}>
        <section role="alertdialog" aria-modal="true" aria-labelledby="hqplayer-existing-title" aria-describedby="hqplayer-existing-description" className={`w-96 rounded-2xl border p-6 shadow-2xl backdrop-blur-xl ${daylight ? 'bg-white/95 border-black/10' : 'bg-neutral-900/95 border-white/10'}`} style={{ color: 'var(--text-primary)' }}>
            <h2 id="hqplayer-existing-title" className="text-base font-semibold">{t('hqpLaunch.existingTitle')}</h2>
            <p id="hqplayer-existing-description" className="my-4 text-sm opacity-80">{t('hqpLaunch.existingDescription')}</p>
            <div className="flex justify-end gap-3"><button autoFocus className="rounded-lg border px-4 py-2 text-sm" onClick={() => prompt.choose(false)}>{t('hqpLaunch.no')}</button><button className="rounded-lg border px-4 py-2 text-sm" onClick={() => prompt.choose(true)}>{t('hqpLaunch.yes')}</button></div>
        </section>
    </div>;
}
