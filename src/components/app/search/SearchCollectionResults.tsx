import React from 'react';
import { Disc, UserRound } from 'lucide-react';
import { List } from 'react-window';
import type { ProviderCollection } from '../../../types/onlineMusic';
import {useSearchListScroll} from './useSearchListScroll';

// Collection search opens the original artist/album surface; it never invents a playable song.
type Props = {collections:ProviderCollection[];onOpen:(collection:ProviderCollection)=>void};
const Row = ({index,style,collections,onOpen}:Props & {index:number;style:React.CSSProperties}) => {
    const collection = collections[index], Icon = collection.type === 'artist' ? UserRound : Disc;
    return <div style={style} className="px-1 py-1">
        <button type="button" onClick={() => onOpen(collection)} className="flex h-full w-full items-center gap-4 rounded-2xl border border-current/10 bg-current/[0.03] px-4 text-left hover:bg-current/10">
            {collection.coverUrl ? <img src={collection.coverUrl} alt="" className={`h-12 w-12 shrink-0 object-cover ${collection.type === 'artist' ? 'rounded-full' : 'rounded-xl'}`} /> : <Icon className="h-12 w-12 shrink-0 opacity-35" />}
            <span className="min-w-0"><span className="block truncate font-semibold">{collection.name}</span><span className="block truncate text-xs opacity-55">{collection.artists?.map(artist=>artist.name).join(' / ')}</span></span>
        </button>
    </div>;
};
export const SearchCollectionResults = ({scrollTop,onScrollTopChange,...props}:Props & {scrollTop:number;onScrollTopChange:(top:number)=>void}) => {
    const scroll=useSearchListScroll(props.collections,scrollTop,onScrollTopChange);
    return <List {...scroll} rowComponent={Row as any} rowProps={props} rowCount={props.collections.length} rowHeight={78} overscanCount={5} className="custom-scrollbar" style={{height:'100%',width:'100%'}} />;
};
