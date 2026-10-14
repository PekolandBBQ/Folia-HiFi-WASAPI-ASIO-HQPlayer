import { useEffect, useRef } from 'react';
import type { SettingsAnchor } from '../components/modal/settings/navigation/settingsAnchorStore';
import type { SettingsModalState } from '../stores/useSettingsModalStore';

// src/hooks/useSettingsInitialAnchor.ts
// Lands the settings dialog on a section rather than at the top of its page.
//
// The scroll cannot happen when the request arrives: <SettingsAnchor> registers in a layout effect,
// so the target does not exist until the requested subview has mounted and rendered. Waiting for it
// to appear in the registry is the only signal that it is safe to scroll — and it is also what makes
// this work for the sections that render conditionally.

export const useSettingsInitialAnchor = (
    initialAnchor: SettingsModalState['initialAnchor'],
    anchors: SettingsAnchor[],
    scrollToAnchor: (anchorId: string, behavior?: ScrollBehavior) => void,
    containerRef?: React.RefObject<HTMLElement | null>,
) => {
    // Keyed on the request's seq, not its id: asking for the same section twice has to scroll twice,
    // and a re-render that merely re-registers the anchors must not scroll at all.
    const servedSeqRef = useRef<number | null>(null);
    const interruptedSeqRef = useRef<number | null>(null);

    useEffect(() => {
        if (!initialAnchor) {
            servedSeqRef.current = null;
            return;
        }
        if (servedSeqRef.current === initialAnchor.seq) {
            return;
        }
        if (!anchors.some(anchor => anchor.id === initialAnchor.id)) {
            return;
        }

        servedSeqRef.current = initialAnchor.seq;
        scrollToAnchor(initialAnchor.id);
    }, [anchors, initialAnchor, scrollToAnchor]);

    // Status/DSP panels above the destination can expand after mount. Keep the requested section
    // in view during those discrete layout changes, but give up as soon as the user takes control.
    useEffect(() => {
        const container = containerRef?.current;
        const target = anchors.find(anchor => anchor.id === initialAnchor?.id)?.node as HTMLElement | undefined;
        if (!initialAnchor || !container || !target || interruptedSeqRef.current === initialAnchor.seq
            || typeof ResizeObserver === 'undefined') return;
        const offset = () => target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        let previousOffset = offset();
        const observer = new ResizeObserver(() => {
            const nextOffset = offset();
            if (Math.abs(nextOffset - previousOffset) < 1) return;
            previousOffset = nextOffset;
            scrollToAnchor(initialAnchor.id, 'auto');
        });
        for (const anchor of anchors) observer.observe(anchor.node as Element);
        const interrupt = () => {
            interruptedSeqRef.current = initialAnchor.seq;
            observer.disconnect();
        };
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
        for (const event of events) document.addEventListener(event, interrupt, { capture: true, passive: true });
        return () => {
            observer.disconnect();
            for (const event of events) document.removeEventListener(event, interrupt, true);
        };
    }, [anchors, containerRef, initialAnchor, scrollToAnchor]);
};
