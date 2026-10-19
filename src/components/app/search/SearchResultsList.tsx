import React, { useMemo } from 'react';
import { List } from 'react-window';
import { useSearchListScroll } from './useSearchListScroll';
import type { UnifiedSong } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import SearchResultRow from './SearchResultRow';

// src/components/app/search/SearchResultsList.tsx

type SearchResultsListProps = {
    tracks: UnifiedSong[];
    scrollTop: number;
    isDaylight: boolean;
    onScrollTopChange: (scrollTop: number) => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
};

type RowProps = Omit<SearchResultsListProps, 'scrollTop' | 'onScrollTopChange'>;

const Row = ({ index, style, tracks, ...props }: { index: number; style: React.CSSProperties } & RowProps) => (
    <SearchResultRow track={tracks[index]} style={style} {...props} />
);

const SearchResultsList: React.FC<SearchResultsListProps> = ({
    tracks,
    scrollTop,
    onScrollTopChange,
    ...rowProps
}) => {
    const {listRef,onScroll} = useSearchListScroll(tracks,scrollTop,onScrollTopChange);
    const stableRowProps = useMemo(() => ({ tracks, ...rowProps }), [rowProps, tracks]);

    return (
        <List
            listRef={listRef}
            rowCount={tracks.length}
            rowHeight={76}
            rowComponent={Row as any}
            rowProps={stableRowProps}
            overscanCount={6}
            className="custom-scrollbar"
            style={{ height: '100%', width: '100%' }}
            onScroll={onScroll}
        />
    );
};

export default SearchResultsList;
