import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {Theme} from '../../src/types';
import type {ProviderCollection} from '../../src/types/onlineMusic';
import SearchWorkspace from '../../src/components/app/search/SearchWorkspace';
import {CollectionSubscriptionButton} from '../../src/components/shared/CollectionSubscriptionButton';
import {ArtistGridInfoCutInPanel} from '../../src/library/suites/grid/artist/ArtistGridInfoCutInPanel';
import {useSearchNavigationStore} from '../../src/stores/useSearchNavigationStore';
import {useOnlineProviderAccountStore} from '../../src/stores/useOnlineProviderAccountStore';
import {subscribeOnlineLibraryChanges} from '../../src/services/onlineMusic/libraryChanges';
import {spotifyProvider} from '../../src/services/onlineMusic/spotifyProvider';
import {registerOnlineMusicProvider} from '../../src/services/onlineMusic/providerRegistry';
import type {ProbeDefinition} from './definition';

// Actual search workspace, store, Omni adapter and original artist panel under controlled IPC.
function SpotifyCatalogProbe(){
 const {t}=useTranslation(),[selected,setSelected]=useState<ProviderCollection|null>(null),[favorites,setFavorites]=useState('');
 const daylight=new URLSearchParams(location.search).has('daylight');
 const theme={primaryColor:daylight?'#171717':'#eeeeee',accentColor:daylight?'#171717':'#eeeeee',backgroundColor:daylight?'#fafafa':'#111111'} as Theme;
 const deps={localSongs:[],t:(key:string,fallback?:string)=>t(key,{defaultValue:fallback||key})};
 useEffect(()=>{
  registerOnlineMusicProvider(spotifyProvider);useSearchNavigationStore.getState().resetRuntime('spotify');
  useSearchNavigationStore.getState().setSearchQuery('Online artist');
  useOnlineProviderAccountStore.getState().updateAccount('spotify',{status:'authenticated',user:{id:'me',nickname:'Listener'}});
  useOnlineProviderAccountStore.getState().setActiveProviderId('spotify');
  void useSearchNavigationStore.getState().submitSearch({sourceTab:'spotify',deps});
  return subscribeOnlineLibraryChanges(change=>setFavorites(change.collections.map(item=>item.name).join(', ')));
 },[]);
 const back=()=>{setSelected(null);const state=useSearchNavigationStore.getState();state.restoreSearch({query:state.searchQuery,sourceTab:'spotify'});};
 return <div style={{color:theme.primaryColor,background:theme.backgroundColor,'--text-primary':theme.primaryColor,'--bg-color':theme.backgroundColor} as React.CSSProperties} className="min-h-screen">
  <output data-testid="confirmed-favorites" className="fixed bottom-5 right-5 z-[100] rounded-xl bg-black/50 p-2 text-xs text-white">{favorites}</output>
  <SearchWorkspace theme={theme} isDaylight={daylight} onClose={()=>useSearchNavigationStore.getState().hideSearchOverlay()}
   onSubmitSearch={source=>{void useSearchNavigationStore.getState().submitSearch({sourceTab:source||'spotify',deps});}}
   onLoadMore={()=>{void useSearchNavigationStore.getState().loadMoreSearchResults({deps});}}
   onPlayTrack={()=>{}} onAddTrackToQueue={()=>{}} onOpenArtist={()=>{}} onOpenAlbum={()=>{}}
   onOpenCollection={collection=>{setSelected(collection);useSearchNavigationStore.getState().hideSearchOverlay();}} />
  {selected&&<>
   <button className="fixed right-8 top-8 z-[90] rounded-full border px-4 py-2" onClick={back}>Back to search</button>
   {selected.type==='artist'?<ArtistGridInfoCutInPanel isOpen artistName={selected.name} collection={selected} onClose={back}/>
    :<section className="mx-auto max-w-md pt-32"><h1>{selected.name}</h1><CollectionSubscriptionButton collection={selected}/></section>}
  </>}
 </div>;
}
export default {id:'spotifyCatalog',title:'Spotify catalog search and subscriptions',description:'Shared search and remote-confirmed library mutations.',Component:SpotifyCatalogProbe} satisfies ProbeDefinition;
