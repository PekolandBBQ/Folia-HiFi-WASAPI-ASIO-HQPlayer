import { CircleAlert, Disc3, Languages, Newspaper, WifiOff, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/components/modal/newFeaturesRelease.ts

type NewFeatureCard = {
    id: string;
    icon: LucideIcon;
    daylightIconClassName: string;
    darkIconClassName: string;
};

type NewFeaturesRelease = {
    i18nKey: string;
    /** 重大更新：介绍上方显示「<代号> Update · 重大更新」标签；代号不翻译，文案在 help.majorUpdateLabel。 */
    majorUpdate?: { codename: string };
    features: NewFeatureCard[];
};

// Defines the current release's cards; their localized text lives under i18nKey in every locale.
export const NEW_FEATURES_RELEASE: NewFeaturesRelease = {
    i18nKey: 'releaseNotes.v0_7_19',
    features: [
        { id: 'artistPoster', icon: Newspaper, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
        { id: 'albumPoster', icon: Disc3, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'playbackFailure', icon: CircleAlert, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'lyricSegmenter', icon: Languages, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'offlineStartup', icon: WifiOff, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'stabilityFixes', icon: Wrench, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
    ],
};
