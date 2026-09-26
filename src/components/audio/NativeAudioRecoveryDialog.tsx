import { useTranslation } from 'react-i18next';
import ThemedDialog from '../shared/ThemedDialog';
import { useNativeRecoveryStore } from '../../stores/useNativeRecoveryStore';

// src/components/audio/NativeAudioRecoveryDialog.tsx — same dialog surface as existing Folia prompts.
export default function NativeAudioRecoveryDialog({ isDaylight = false }: { isDaylight?: boolean }) {
    const { t } = useTranslation();
    const { errorCode, busy, choose } = useNativeRecoveryStore();
    return <ThemedDialog isOpen={Boolean(errorCode)} title={t('nativeAudio.recoveryTitle')}
        isDaylight={isDaylight} closeDisabled={busy}
        onClose={() => useNativeRecoveryStore.setState({ errorCode: null, choose: null })}>
        <p role="alert" className="mb-4 text-sm opacity-80">{t(`nativeAudio.errors.${errorCode || 'NATIVE_REQUEST_FAILED'}`)}</p>
        <div className="flex flex-wrap gap-2">
            {(['retry', 'browser', 'rollback'] as const).map(choice => <button key={choice} disabled={busy}
                className="rounded-xl border border-current/20 px-4 py-2 text-sm hover:bg-gray-500/15 disabled:opacity-40"
                onClick={() => void choose?.(choice)}>{t(`nativeAudio.recovery.${choice}`)}</button>)}
        </div>
    </ThemedDialog>;
}
