import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

// Copy only the current app palette across the portal boundary without writing any theme settings.
const keys = ['--bg-color', '--text-primary', '--text-secondary', '--text-accent'] as const;
export function useSpotifyPortalTheme(daylight: boolean) {
    const origin = useRef<HTMLSpanElement>(null);
    const [palette, setPalette] = useState<CSSProperties>({});
    useLayoutEffect(() => {
        const anchor = origin.current;
        if (!anchor) return;
        let owner = anchor.parentElement;
        while (owner?.parentElement && !owner.style.getPropertyValue('--text-primary')) owner = owner.parentElement;
        if (!owner) return;
        const themeOwner = owner;
        const read = () => {
            const computed = getComputedStyle(anchor);
            const next = Object.fromEntries(keys.map(key => [key,
                computed.getPropertyValue(key).trim() || themeOwner.style.getPropertyValue(key).trim(),
            ]).filter(([, value]) => value)) as CSSProperties;
            setPalette(previous => keys.every(key => (previous as Record<string, string>)[key] === (next as Record<string, string>)[key]) ? previous : next);
        };
        read();
        const observer = new MutationObserver(read);
        observer.observe(themeOwner, { attributes: true, attributeFilter: ['style', 'class'] });
        return () => observer.disconnect();
    }, [daylight]);
    const fallback = { '--bg-color': daylight ? '#fafafa' : '#09090b', '--text-primary': daylight ? '#18181b' : '#e4e4e7',
        '--text-secondary': daylight ? '#52525b' : '#a1a1aa', '--text-accent': daylight ? '#18181b' : '#e4e4e7' };
    return { origin, palette: { ...fallback, ...palette } as CSSProperties };
}
