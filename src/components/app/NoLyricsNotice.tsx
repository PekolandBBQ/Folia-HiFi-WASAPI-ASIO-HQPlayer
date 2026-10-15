import { useNativeLyricsResultStore } from '../../stores/useNativeLyricsResultStore';
import './NoLyricsNotice.css';

// Display an empty response as UI text, not as a fabricated timed lyric line.
export const NO_LYRICS_NOTICE = '当前歌曲无歌词或为纯音乐，请欣赏';
export default function NoLyricsNotice({ songKey, card = false }: { songKey: string; card?: boolean }) {
    const empty = useNativeLyricsResultStore(state => state.songKey === songKey && state.state === 'empty');
    if (!empty) return null;
    return <div role="status" className={`folia-no-lyrics ${card ? 'lattice-lyrics is-ready folia-no-lyrics--card' : 'folia-no-lyrics--player'}`}>
        <span>{NO_LYRICS_NOTICE}</span>
    </div>;
}
