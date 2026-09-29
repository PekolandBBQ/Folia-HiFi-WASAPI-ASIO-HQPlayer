import type { ProbeDefinition } from './definition';
import HQPlayerSettingsSection from '../../src/components/modal/settings/HQPlayerSettingsSection';

// Exercise the real independent component lifecycle UI against an injected IPC boundary.
function Component() { return <div className="p-8 max-w-2xl"><HQPlayerSettingsSection className="border-white/10" /></div>; }
export default { id: 'hqplayerComponent', title: 'HQPlayer component', description: 'Independent version and lifecycle', Component } satisfies ProbeDefinition;
