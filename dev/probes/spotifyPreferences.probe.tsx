import SpotifyExitSetting from '../../src/components/app/home/SpotifyExitSetting';
import AudioSignalPathSettingsSection from '../../src/components/modal/settings/AudioSignalPathSettingsSection';
import type { ProbeDefinition } from './definition';
// Real controls, with the desktop transport supplied by the test.
const probe: ProbeDefinition={id:'spotifyPreferences',title:'Spotify preferences',description:'Exit preference and shared signal path',Component:()=> <div className="p-8 space-y-6"><SpotifyExitSetting /><AudioSignalPathSettingsSection className="" /></div>};
export default probe;

