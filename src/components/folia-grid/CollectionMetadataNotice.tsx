import { useTranslation } from 'react-i18next';
import type { ProviderMetadataStatus } from '../../types/onlineMusic';

// CollectionMetadataNotice.tsx — Public metadata coverage never implies a complete or playable library.
export function publicPlaylistSourceUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]{22}$/.test(value)) return undefined;
    return value;
}

export default function CollectionMetadataNotice({ metadata }: { metadata: ProviderMetadataStatus | null }) {
    const { t } = useTranslation();
    if (metadata?.metadataSource !== 'spotify-public-embed') return null;
    const complete = metadata.metadataCompleteness === 'complete';
    const sourceUrl = publicPlaylistSourceUrl(metadata.sourceUrl);
    return (
        <div role="status" data-testid="collection-metadata-notice"
            className="mt-1 max-w-[min(38rem,calc(100vw-8rem))] text-xs leading-relaxed whitespace-normal break-words"
            onClick={event => event.stopPropagation()}>
            <span>{t(complete ? 'spotifyLibrary.publicComplete' : 'spotifyLibrary.publicPartial', {
                count: metadata.loadedCount ?? 0,
            })}</span>
            {' '}
            {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {t('spotifyLibrary.openOriginal')}
            </a>}
        </div>
    );
}
