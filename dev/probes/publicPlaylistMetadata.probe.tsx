import { useState } from 'react';
import CollectionMetadataNotice from '../../src/library/suites/grid/shared/CollectionMetadataNotice';
import type { ProviderMetadataStatus } from '../../src/types/onlineMusic';
import type { ProbeDefinition } from './definition';

// publicPlaylistMetadata.probe.tsx — Uses the actual coverage component without accounts or network requests.
const publicMetadata: ProviderMetadataStatus = {
    metadataSource: 'spotify-public-embed', metadataCompleteness: 'partial', loadedCount: 23,
    sourceUrl: 'https://open.spotify.com/playlist/5ZAFjUGN7Wsip8May2qDuq',
};
function PublicPlaylistMetadataProbe() {
    const [metadata, setMetadata] = useState<ProviderMetadataStatus | null>(publicMetadata);
    const [light, setLight] = useState(false);
    const [parentClicks, setParentClicks] = useState(0);
    return (
        <div className="min-h-screen p-6" style={{ background: light ? '#f7f7f7' : '#191919', color: light ? '#181818' : '#fafafa' }}>
            <div className="flex flex-wrap gap-4 mb-8">
                <button onClick={() => setMetadata(publicMetadata)}>Public</button>
                <button onClick={() => setMetadata({ metadataSource: 'spotify-api' })}>API</button>
                <button onClick={() => setMetadata(null)}>Close</button>
                <button onClick={() => setLight(value => !value)}>Theme</button>
            </div>
            <div className="flex flex-col items-center text-center mx-auto w-fit p-4 rounded-2xl" onClick={() => setParentClicks(value => value + 1)}>
                <h2 className="text-lg font-bold">ZUTOMAYO</h2>
                <CollectionMetadataNotice metadata={metadata} />
            </div>
            <output data-testid="parent-clicks">{parentClicks}</output>
        </div>
    );
}
const definition: ProbeDefinition = {
    id: 'publicPlaylistMetadata', title: 'Public playlist metadata coverage',
    description: 'Official source link, explicit incomplete coverage, theme and repeated source transitions.',
    Component: PublicPlaylistMetadataProbe,
};
export default definition;
