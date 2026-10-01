import { useTranslation } from 'react-i18next';
import { CustomSelect } from '../shared/CustomSelect';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { formatHQPlayerRate } from '../../utils/hqplayerRate';
import type { HQPlayerDspCatalog, HQPlayerDspSettings } from '../../types/hqplayerDsp';

// Floating and persistent settings share the same themed selectors.
export default function HQPlayerDspFields({ data, draft, setDraft, disabled }: {
    data: HQPlayerDspCatalog; draft: HQPlayerDspSettings; setDraft: (value: HQPlayerDspSettings) => void; disabled: boolean;
}) {
    const { t } = useTranslation();
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const list = data.catalogs[draft.mode];
    const sdm = data.modes.find(mode => mode.index === draft.mode)?.value === 1;
    const select = (label: string, value: string, options: { value: string; label: string }[], onChange: (value: string) => void) =>
        <div className="space-y-1 text-xs"><span>{label}</span><CustomSelect frosted ariaLabel={label} value={value} options={options} onChange={onChange} disabled={disabled} isDaylight={isDaylight} /></div>;
    return <div className="space-y-3">
        {select(t('hqpDsp.mode'), String(draft.mode), data.modes.map(item => ({ value: String(item.index), label: item.name })), value => {
            const mode = Number(value), catalog = data.catalogs[mode];
            setDraft({ mode, filter: catalog?.filters[0]?.name || '', shaper: catalog?.shapers[0]?.name || '', rate: catalog?.rates[0]?.rate ?? 0 });
        })}
        {list ? <>
            {select(t('hqpDsp.filter'), draft.filter, list.filters.map(item => ({ value: item.name, label: item.name })), filter => setDraft({ ...draft, filter }))}
            {select(t('hqpDsp.shaper'), draft.shaper, list.shapers.map(item => ({ value: item.name, label: item.name })), shaper => setDraft({ ...draft, shaper }))}
            {select(t('hqpDsp.rate'), String(draft.rate), list.rates.map(item => ({ value: String(item.rate), label: item.rate ? formatHQPlayerRate(item.rate, sdm) : t('hqpDsp.auto') })), value => setDraft({ ...draft, rate: Number(value) }))}
        </> : <p>{t('hqpDsp.stopToRead')}</p>}
    </div>;
}
