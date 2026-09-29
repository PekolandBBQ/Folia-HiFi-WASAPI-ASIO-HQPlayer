import { useLayoutEffect, useRef, type AudioHTMLAttributes } from 'react';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { beginPlaybackLoad, endPlaybackLoad } from '../../../stores/usePlaybackLoadStore';

// Only the current deck owns visible buffering telemetry; preloaded/warm audio stays quiet.
export default function BrowserPlaybackDeck({ register, ...props }: AudioHTMLAttributes<HTMLAudioElement> & {
    register: (element: HTMLAudioElement | null) => void;
}) {
    const ref = useRef<HTMLAudioElement>(null);
    useLayoutEffect(() => {
        const audio = ref.current!;
        const owner = `browser:${crypto.randomUUID()}`;
        const start = () => {
            if (props.src && usePlaybackStore.getState().audioSrc === props.src) beginPlaybackLoad(owner, 'buffer');
        };
        const end = () => endPlaybackLoad(owner);
        for (const name of ['loadstart', 'waiting', 'stalled']) audio.addEventListener(name, start);
        for (const name of ['canplay', 'playing', 'error', 'emptied', 'abort']) audio.addEventListener(name, end);
        register(audio);
        if (props.src && audio.readyState < 3) start();
        return () => {
            register(null); end();
            for (const name of ['loadstart', 'waiting', 'stalled']) audio.removeEventListener(name, start);
            for (const name of ['canplay', 'playing', 'error', 'emptied', 'abort']) audio.removeEventListener(name, end);
        };
    }, [register, props.src]);
    return <audio {...props} ref={ref} />;
}
