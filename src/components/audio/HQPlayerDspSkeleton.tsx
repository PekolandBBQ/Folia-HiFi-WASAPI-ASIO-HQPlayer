import { useTranslation } from 'react-i18next';

// Reserve the complete editor layout while the first catalog is being read; no empty actions flash.
export default function HQPlayerDspSkeleton() {
    const { t } = useTranslation();
    return <div data-hqplayer-dsp-skeleton aria-hidden="true" className="space-y-3">
        {(['mode', 'filter', 'shaper', 'rate'] as const).map(key => <div key={key} className="space-y-1 text-xs">
            <span>{t(`hqpDsp.${key}`)}</span><div className="flex h-[46px] items-center rounded-xl border border-current/15 bg-current/5 px-4"><span className="h-2 w-2/3 rounded-full bg-current/10" /></div>
        </div>)}
        <div className="mt-3 flex gap-2"><div className="h-9 w-28 rounded-lg border border-current/15 bg-current/5" /><div className="h-9 w-28 rounded-lg border border-current/15 bg-current/5" /></div>
    </div>;
}
