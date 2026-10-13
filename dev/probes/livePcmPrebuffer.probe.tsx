import LivePcmPrebufferSetting from '../../src/components/audio/LivePcmPrebufferSetting';
import HQPlayerSpotifyExperimentSettings from '../../src/components/audio/HQPlayerSpotifyExperimentSettings';
import type { ProbeDefinition } from './definition';

// Real settings controls in both Folia surface colors; no audio service or remote requests.
function LivePcmPrebufferProbe() {
    return <div className="grid min-h-screen gap-6 p-8 md:grid-cols-2" style={{ background: '#767b85' }}>
        {[true, false].map(daylight => <div key={String(daylight)} data-testid={daylight ? 'light-settings' : 'dark-settings'}
            className={`rounded-xl border p-4 ${daylight ? 'bg-slate-100 text-slate-900 border-black/10' : 'bg-slate-800 text-white border-white/10'}`}
            style={{ '--text-primary': daylight ? '#18181b' : '#fafafa', '--text-secondary': daylight ? '#51515b' : '#b7bdc8', '--accent-color': daylight ? '#545ab3' : '#b7baff' } as React.CSSProperties}>
            <LivePcmPrebufferSetting />
            <HQPlayerSpotifyExperimentSettings />
            <LivePcmPrebufferSetting disabled />
        </div>)}
    </div>;
}
export default { id: 'livePcmPrebuffer', title: 'Spotify PCM prebuffer', description: 'Shared target and independent HQ delay in light and dark settings.', Component: LivePcmPrebufferProbe } satisfies ProbeDefinition;
