import {useEffect,useRef} from 'react';
import {useListRef} from 'react-window';

// Song and catalog results share the original debounced scroll/return behavior.
export const useSearchListScroll = (items:readonly unknown[],scrollTop:number,onChange:(top:number)=>void) => {
    const listRef=useListRef(null),latest=useRef(scrollTop),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
    useEffect(()=>{
        const element=listRef.current?.element;
        if(element&&Math.abs(element.scrollTop-scrollTop)>1)element.scrollTop=scrollTop;
        latest.current=scrollTop;
    },[listRef,scrollTop,items]);
    useEffect(()=>()=>{
        if(timer.current)clearTimeout(timer.current);
        onChange(latest.current);
    },[onChange]);
    const onScroll=(event:React.UIEvent<HTMLDivElement>)=>{
        latest.current=event.currentTarget.scrollTop;
        if(timer.current)clearTimeout(timer.current);
        timer.current=setTimeout(()=>onChange(latest.current),120);
    };
    return {listRef,onScroll};
};
