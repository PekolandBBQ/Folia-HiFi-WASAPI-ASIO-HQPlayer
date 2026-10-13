import { Music2, Cable, Monitor, Images, AudioLines } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/components/modal/newFeaturesRelease.ts: fork revision cards retain the upstream application version.
type NewFeatureCard = { id: string; icon: LucideIcon; daylightIconClassName: string; darkIconClassName: string };
type NewFeaturesRelease = { i18nKey: string; features: NewFeatureCard[] };
export const NEW_FEATURES_RELEASE: NewFeaturesRelease = {
    i18nKey: 'releaseNotes.hifi0_7_12r3',
    features: [
        { id: 'spotifyWrapper', icon: Music2, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'spotifySetup', icon: Cable, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'spotifyDesktop', icon: Monitor, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'spotifyLibrary', icon: Images, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'spotifyCapture', icon: AudioLines, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
    ],
};
