import { useNativeLyricsResultStore } from '../../src/stores/useNativeLyricsResultStore';
import NoLyricsNotice from '../../src/components/app/NoLyricsNotice';
import { useState } from 'react';
import { useMotionValue } from 'framer-motion';
import LibraryCardLyricsHost from '../../src/components/app/home/LibraryCardLyricsHost';
import BravaisFocusCardBody from '../../src/library/suites/bravais/BravaisFocusCardBody';
import { getPlaybackSongKey } from '../../src/utils/appPlaybackGuards';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { SongResult } from '../../src/types';
import type { ProbeDefinition } from './definition';
import '../../src/components/wall/wall.css';
import '../../src/library/suites/bravais/bravais.css';

// Real shared canvas and real library card, with a controllable clock and no audio account.
function CardLyricsProbe() {
    const time = useMotionValue(1);
    const [details, setDetails] = useState(false);
    const [line, setLine] = useState(0);
    const [lyrics, setLyrics] = useState(true);
    const [current, setCurrent] = useState(true);
    const song = { id: 'card', name: 'Card title', artists: [], album: { id: 1, name: 'Album' }, durationMs: 20000 } as SongResult;
    return <LibraryCardLyricsHost song={song} keywordColoringEnabled={false} source={{ currentTime: time, currentLineIndex: line,
        theme: DEFAULT_THEME, lines: lyrics ? [
            { fullText: '第一行滚动歌词', startTime: 0, endTime: 8, words: [] },
            { fullText: '第二行滚动歌词', startTime: 8, endTime: 20, words: [] },
        ] : [] }}>
        <div className="bravais-root" style={{ color: 'white', background: '#151515', height: '100vh' }}>
            <div className="lattice-poster is-expanded" style={{ position: 'relative', width: 650, height: 650 }}>
                <>{details ? <NoLyricsNotice songKey={getPlaybackSongKey(song)} /> : <BravaisFocusCardBody slotKey="0" item={{ key: 'card-0', playbackKey: getPlaybackSongKey(song), kind: 'track', title: song.name, subtitle: '', badge: '1' }}
                    queued current={current} titleWidth={650} actions={{ play: () => {}, enqueue: () => {}, canOpenAlbum: () => false,
                        canOpenArtist: () => false, openAlbum: () => {}, openArtist: () => {}, menuFor: () => [], runMenu: () => {}, hover: () => {}, togglesCurrent: true }} />}</>
            </div>
            <button onClick={() => { time.set(10); setLine(1); }}>Advance lyrics</button>
            <button onClick={() => { setLyrics(false); useNativeLyricsResultStore.setState({ songKey: getPlaybackSongKey(song), state: 'empty' }); }}>No lyrics</button>
            <button onClick={() => {setLyrics(false);useNativeLyricsResultStore.setState({songKey:getPlaybackSongKey(song),state:'loading'});}}>Loading</button>
            <button onClick={() => useNativeLyricsResultStore.setState({songKey:getPlaybackSongKey(song),state:'error'})}>Failed</button>
            <button onClick={() => setDetails(true)}>Details</button>
            <button onClick={() => setCurrent(false)}>Other card</button>
        </div>
    </LibraryCardLyricsHost>;
}
export default { id: 'bravaisCardLyrics', title: 'Library card lyrics', description: 'Shared scrolling canvas and title fallback', Component: CardLyricsProbe } satisfies ProbeDefinition;
