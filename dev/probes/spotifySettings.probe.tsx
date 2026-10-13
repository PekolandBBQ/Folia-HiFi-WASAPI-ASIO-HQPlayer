import SpotifySettingsSection from '../../src/components/modal/settings/SpotifySettingsSection';
import { useThemeSettingsStore } from '../../src/stores/useThemeSettingsStore';
import type { ProbeDefinition } from './definition';

// Production public connection settings, with the same theme surface as the integrations view.
function SpotifySettingsProbe() {
    const daylight = useThemeSettingsStore(state => state.isDaylight);
    return <div className={`min-h-screen p-8 ${daylight ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-white'}`}>
        <div className="max-w-3xl"><SpotifySettingsSection settingsCardClass={daylight ? 'bg-white/40 border-black/10' : 'bg-white/5 border-white/10'} /></div>
    </div>;
}
export default { id: 'spotifySettings', title: 'Spotify connection settings', description: 'Public client configuration through Omni.', Component: SpotifySettingsProbe } satisfies ProbeDefinition;
