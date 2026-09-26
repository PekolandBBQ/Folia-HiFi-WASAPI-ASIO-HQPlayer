import { useLayoutEffect, useRef } from 'react';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';

// Animate breakpoint changes only; text stays unscaled and no per-frame React updates are needed.
export function useSignalPathTransition(open: boolean, layout: string) {
    const ref = useRef<HTMLElement>(null);
    const previous = useRef<{ width: number; height: number; rows: Array<{ x: number; y: number }> } | null>(null);
    const animations = useRef<Animation[]>([]);
    const reducedMotion = useReducedMotionFor('uiMicroMotion');
    useLayoutEffect(() => {
        const panel = ref.current;
        animations.current.forEach(animation => animation.cancel());
        animations.current = [];
        if (!open || !panel) { previous.current = null; return; }
        const box = panel.getBoundingClientRect();
        const rows = Array.from(panel.querySelectorAll<HTMLElement>('.signal-path-rows > li'));
        const positions = rows.map(row => { const r = row.getBoundingClientRect(); return { x: r.x - box.x, y: r.y - box.y }; });
        const old = previous.current;
        previous.current = { width: box.width, height: box.height, rows: positions };
        if (!old || reducedMotion) return;
        const timing = { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
        animations.current.push(panel.animate([
            { width: old.width + 'px', height: old.height + 'px', overflow: 'hidden' },
            { width: box.width + 'px', height: box.height + 'px', overflow: 'hidden' },
        ], timing));
        rows.forEach((row, index) => {
            const from = old.rows[index]; const to = positions[index];
            if (from) animations.current.push(row.animate([
                { transform: 'translate(' + (from.x - to.x) + 'px, ' + (from.y - to.y) + 'px)' },
                { transform: 'translate(0, 0)' },
            ], timing));
        });
    }, [open, layout, reducedMotion]);
    useLayoutEffect(() => () => animations.current.forEach(animation => animation.cancel()), []);
    return ref;
}
