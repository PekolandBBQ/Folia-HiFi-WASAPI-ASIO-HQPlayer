import React, { useLayoutEffect, useRef } from 'react';
import { NativeAudioTransport } from '../../../services/nativeAudio/NativeAudioTransport';
import type { NativeAudioBackend } from '../../../types/nativeAudio';

// src/components/app/playback/PlaybackDeck.tsx — media-event compatibility at one explicit boundary.
type Props = React.AudioHTMLAttributes<HTMLAudioElement> & {
    register: (element: HTMLAudioElement | null) => void;
    nativeBackend: NativeAudioBackend;
    nativeDeviceId: string;
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
    useLayoutEffect(() => {
        const audio = new NativeAudioTransport(window.electron!.nativeAudio!, props.nativeBackend,
            props.nativeDeviceId, () => latest.current.getLocalFile());
        transport.current = audio;
        for (const [event, handler] of Object.entries(eventProps)) {
            audio.addEventListener(event, nativeEvent => {
                latest.current[handler]?.({ currentTarget: audio.asMediaElement(), target: audio.asMediaElement(),
                    nativeEvent } as unknown as React.SyntheticEvent<HTMLAudioElement>);
            });
        }
        props.register(audio.asMediaElement());
        audio.loop = Boolean(props.loop);
        audio.setSource(props.src || '');
        return () => { audio.dispose(); props.register(null); transport.current = null; };
    }, [props.register, props.nativeBackend, props.nativeDeviceId]);
    useLayoutEffect(() => {
        if (!transport.current) return;
        transport.current.loop = Boolean(props.loop);
        transport.current.setSource(props.src || '');
    }, [props.src, props.loop]);
    return null;
}

export default function PlaybackDeck(props: Props) {
    const { nativeBackend, nativeDeviceId, getLocalFile, register, ...audioProps } = props;
    return nativeBackend !== 'browser'
        ? <NativeDeck {...props} />
        : <audio {...audioProps} ref={register} />;
}
