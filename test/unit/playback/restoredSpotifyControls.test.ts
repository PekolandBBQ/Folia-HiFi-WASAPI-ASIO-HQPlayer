import { describe, expect, it } from 'vitest';
import { buildPlayerViewFlags } from '@/components/app/presentation/buildPlayerViewFlags';
import type { SongResult } from '@/types';
// The rendered bottom control must allow an explicit resume without a persisted session URL.
const base={currentView:'home',disableHomeDynamicBackground:false,hidePlayerProgressBar:false,hidePlayerTranslationSubtitle:false,hidePlayerRightPanelButton:false,isNowPlayingControlDisabled:false,activePlaybackContext:'main' as const,stageActiveEntryKind:null,audioSrc:null,duration:200};
const song={id:'restored',sourceRef:{kind:'online',providerId:'spotify',mediaId:'restored'}} as SongResult;
describe('restored Spotify bottom control',()=>{
 it('enables remembered Spotify while preserving empty and other-source guards',()=>{
 expect(buildPlayerViewFlags({...base,currentSong:song}).canToggleCurrentPlayback).toBe(true);
 expect(buildPlayerViewFlags(base).canToggleCurrentPlayback).toBe(false);
 expect(buildPlayerViewFlags({...base,currentSong:{...song,sourceRef:{kind:'online',providerId:'qq',mediaId:'q'}}}).canToggleCurrentPlayback).toBe(false);
 expect(buildPlayerViewFlags({...base,currentSong:song,isNowPlayingControlDisabled:true}).canToggleCurrentPlayback).toBe(false);
 });
});
