import { isPassivePlaybackSource } from '../../../services/playbackSourceIntent';
import BrowserPlaybackDeck from './BrowserPlaybackDeck';
import React, { useLayoutEffect, useRef } from 'react';
import { useHQPlayerSettingsStore } from '../../../stores/useHQPlayerSettingsStore';
import { NativeAudioTransport } from '../../../services/nativeAudio/NativeAudioTransport';
import type { NativeAudioBackend, NativeAudioProcessingMode } from '../../../types/nativeAudio';
import { isSpotifyLivePcm } from '../../../services/onlineMusic/spotifyCableSetup';
import { SoloistBrowserTransport } from '../../../services/onlineMusic/SoloistBrowserTransport';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { shouldDeferOutputPreparation } from '../../../services/nativeAudio/outputHandoff';
import { getAudioSourceMetadata } from '../../../services/onlineMusic/audioSourceQuality';

// src/components/app/playback/PlaybackDeck.tsx — media-event compatibility at one explicit boundary.
type Props = React.AudioHTMLAttributes<HTMLAudioElement> & {
    register: (element: HTMLAudioElement | null) => void;
    nativeBackend: NativeAudioBackend;
    nativeDeviceId: string;
    nativeProcessingMode: NativeAudioProcessingMode;
    initialPosition?: number;
    outputRevision?: number;
    getLocalFile: () => Promise<File | null>;
};
const eventProps = {
    loadstart: 'onLoadStart', loadedmetadata: 'onLoadedMetadata', loadeddata: 'onLoadedData', canplay: 'onCanPlay',
    play: 'onPlay', playing: 'onPlaying', pause: 'onPause', timeupdate: 'onTimeUpdate',
    seeking: 'onSeeking', seeked: 'onSeeked', ended: 'onEnded', error: 'onError',
    durationchange: 'onDurationChange', progress: 'onProgress', waiting: 'onWaiting',
} as const;

function NativeDeck(props: Props) {
    const gainDb = useHQPlayerSettingsStore(state => state.gainDb);
    const remember = useHQPlayerSettingsStore(state => state.remember);
    const latest = useRef(props);
    latest.current = props;
    const transport = useRef<NativeAudioTransport | null>(null);
    const generation = useRef(0);
    const configuration = useRef('');
    useLayoutEffect(() => {
        const currentGeneration = ++generation.current;
        const key = JSON.stringify([props.nativeBackend, props.nativeDeviceId, props.nativeProcessingMode, props.outputRevision]);
        if (!transport.current || configuration.current !== key) {
            transport.current?.dispose('handoff');
            const created = props.nativeBackend === 'browser'
                ? new SoloistBrowserTransport({ browserPcm: input => window.electron!.spotify!.browserPcm!(input) })
                : new NativeAudioTransport(window.electron!.nativeAudio!, props.nativeBackend,
                    props.nativeDeviceId, props.nativeProcessingMode, () => latest.current.getLocalFile());
            const hq = useHQPlayerSettingsStore.getState();
            created.setHQPlayerGainSettings(hq.gainDb, hq.remember, hq.setGain);
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
        audio.setSource(props.src || '', props.initialPosition, (shouldDeferOutputPreparation(props.src || '') || isPassivePlaybackSource(props.src || '')));
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
    }, [props.register, props.nativeBackend, props.nativeDeviceId, props.nativeProcessingMode, props.outputRevision]);
    useLayoutEffect(() => {
        if (!transport.current) return;
        transport.current.loop = Boolean(props.loop);
        transport.current.setSource(props.src || '', props.initialPosition, (shouldDeferOutputPreparation(props.src || '') || isPassivePlaybackSource(props.src || '')));
    }, [props.src, props.loop]);
    useLayoutEffect(() => {
        transport.current?.setHQPlayerGainSettings(gainDb, remember, useHQPlayerSettingsStore.getState().setGain);
    }, [gainDb, remember]);
    return null;
}

export default function PlaybackDeck(props: Props) {
    const { nativeBackend, nativeDeviceId, nativeProcessingMode, initialPosition, outputRevision, getLocalFile, register, ...audioProps } = props;
    const song = usePlaybackStore(state => state.currentSong);
    const metadata = song && props.src ? getAudioSourceMetadata(song, props.src) : undefined;
    const soloistBrowser = nativeBackend === 'browser' && song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify'
        && isSpotifyLivePcm(metadata?.playbackTransport) && typeof window.electron?.spotify?.browserPcm === 'function';
    return nativeBackend !== 'browser' || soloistBrowser
        ? <NativeDeck {...props} />
        : <BrowserPlaybackDeck {...audioProps} register={register} />;
}
