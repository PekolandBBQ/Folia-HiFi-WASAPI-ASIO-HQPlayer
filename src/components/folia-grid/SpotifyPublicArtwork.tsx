import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc } from 'lucide-react';

// SpotifyPublicArtwork.tsx — A verified public thumbnail or an explicit, non-spinning unavailable state.
type ArtworkProps = { source?: string; title: string; unavailable: boolean; size?: number };
export default function SpotifyPublicArtwork(props: ArtworkProps) {
    return <ArtworkAttempt key={props.source || 'missing'} {...props} />;
}
function ArtworkAttempt({ source, title, unavailable, size = 48 }: ArtworkProps) {
    const { t } = useTranslation();
    const [loadedSource, setLoadedSource] = useState<string | null>(null);
    const [failedSource, setFailedSource] = useState<string | null>(null);
    const missing = !source || failedSource === source;
    const loaded = Boolean(!missing && source && loadedSource === source);
    return <>
        {!missing && <img key={source} src={source} alt={title} loading="lazy" decoding="async" referrerPolicy="no-referrer"
            ref={element => { if (element?.complete && element.naturalWidth > 0 && loadedSource !== source) setLoadedSource(source!); }}
            onLoad={() => setLoadedSource(source!)} onError={() => setFailedSource(source!)}
            className="w-full h-full object-contain transition-opacity duration-350 pointer-events-none select-none"
            style={{ opacity: loaded ? unavailable ? 0.3 : 1 : 0 }} />}
        {!loaded && <div data-testid="spotify-public-artwork-state"
            role={missing ? 'img' : 'status'} aria-label={t(missing ? 'spotifyLibrary.artworkUnavailable' : 'spotifyLibrary.artworkLoading')}
            className="absolute inset-0 bg-zinc-300/40 dark:bg-zinc-700/40 flex flex-col items-center justify-center gap-2 p-3 text-center">
            <Disc size={size} className="opacity-30" style={{ color: 'var(--text-primary)' }} />
            <span className="text-xs opacity-70">{t(missing ? 'spotifyLibrary.artworkUnavailable' : 'spotifyLibrary.artworkLoading')}</span>
        </div>}
    </>;
}
