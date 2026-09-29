import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { settingsToggleOffClassFor } from '../modal/settings/settingsCardClasses';

// Same track, thumb and day/night palette as the existing playback settings switches.
export default function SettingsSwitch({ checked, onChange, label, disabled = false }: {
    checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean;
}) {
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`h-6 w-12 shrink-0 rounded-full p-1 transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current ${checked ? '' : settingsToggleOffClassFor(isDaylight)}`}
        style={{ backgroundColor: checked ? 'var(--accent-color, rgba(114,119,134,1))' : undefined }}>
        <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`} />
    </button>;
}
