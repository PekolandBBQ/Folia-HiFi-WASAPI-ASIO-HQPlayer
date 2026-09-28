import React, { useLayoutEffect, useRef } from 'react';
import { NativeAudioTransport } from '../../../services/nativeAudio/NativeAudioTransport';
import type { NativeAudioBackend, NativeAudioProcessingMode } from '../../../types/nativeAudio';

// src/components/app/playback/PlaybackDeck.tsx — media-event compatibility at one explicit boundary.
type Props = React.AudioHTMLAttributes<HTMLAudioElement> & {
    register: (element: HTMLAudioElement | null) => void;
    nativeBackend: NativeAudioBackend;
    nativeDeviceId: string;
    nativeProcessingMode: NativeAudioProcessingMode;
    getLocalFile: () => Promise<File | null>;
};
const eventProps = {
    loadstart: 'onLoadStart', loadedmetadata: 'onLoadedMetadata', loadeddata: 'onLoadedData', canplay: 'onCanPlay',
    play: 'onPlay', playing: 'onPlaying', pause: 'onPause', timeupdate: 'onTimeUpdate',
    seeking: 'onSeeking', seeked: 'onSeeked', ended: 'onEnded', error: 'onError',
} as const;

function NativeDeck(props: Props) {
    const latest = useRef(props);
    latest.current = props;
    const transport = useRef<NativeAudioTransport | null>(null);
    const generation = useRef(0);
    const configuration = useRef('');
    useLayoutEffect(() => {
        const currentGeneration = ++generation.current;
        const key = JSON.stringify([props.nativeBackend, props.nativeDeviceId, props.nativeProcessingMode]);
        if (!transport.current || configuration.current !== key) {
            transport.current?.dispose();
            const created = new NativeAudioTransport(window.electron!.nativeAudio!, props.nativeBackend,
                props.nativeDeviceId, props.nativeProcessingMode, () => latest.current.getLocalFile());
            transport.current = created;
            configuration.current = key;
            for (const [event, handler] of Object.entries(eventProps)) {
                created.addEventListener(event, nativeEvent => {
                    latest.current[handler]?.({ currentTarget: created.asMediaElement(), target: created.asMediaElement(),
                        nativeEvent } as unknown as React.SyntheticEvent<HTMLAudioElement>);
                });
            }
        }
        const audio = transport.current;
        props.register(audio.asMediaElement());
        audio.loop = Boolean(props.loop);
        audio.setSource(props.src || '');
        return () => {
            props.register(null);
            // StrictMode replays layout effects synchronously. Keep its in-flight play request;
            // a real unmount still disposes at the next microtask, and a backend change replaces it.
            queueMicrotask(() => {
                if (generation.current !== currentGeneration) return;
                audio.dispose();
                if (transport.current === audio) transport.current = null;
            });
        };
    }, [props.register, props.nativeBackend, props.nativeDeviceId, props.nativeProcessingMode]);
    useLayoutEffect(() => {
        if (!transport.current) return;
        transport.current.loop = Boolean(props.loop);
        transport.current.setSource(props.src || '');
    }, [props.src, props.loop]);
    return null;
}

export default function PlaybackDeck(props: Props) {
    const { nativeBackend, nativeDeviceId, nativeProcessingMode, getLocalFile, register, ...audioProps } = props;
    return nativeBackend !== 'browser'
        ? <NativeDeck {...props} />
        : <audio {...audioProps} ref={register} />;
}
