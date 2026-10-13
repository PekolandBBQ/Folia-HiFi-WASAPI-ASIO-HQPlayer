// src/components/floating-player/playerProgressAppearance.ts
// The song capsule and loading disclosure share the player's existing surfaces and progress palette.
export const PLAYER_PROGRESS_FRAME_CLASS = 'backdrop-blur-xl shadow-2xl transition-colors duration-300';
export const PLAYER_PROGRESS_TEXT_CLASS = 'text-[10px] font-medium opacity-60 text-[var(--folium-progress-text)]';
export const PLAYER_PROGRESS_NUMERIC_CLASS = 'font-mono';

export const playerProgressGlass = (daylight: boolean, expanded = false) => expanded
    ? daylight ? 'bg-white/60 border border-white/20 shadow-xl' : 'bg-black/40 border border-white/5'
    : daylight ? 'bg-white/40 border border-white/20 shadow-lg hover:bg-white/50' : 'bg-black/20 border border-white/5 hover:bg-black/30';

export const playerProgressTrackColor = (daylight: boolean) => daylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)';

export const playerProgressVariables = (daylight: boolean) => ({
    '--folium-progress-fill': 'var(--text-primary)',
    '--folium-progress-track': playerProgressTrackColor(daylight),
    '--folium-progress-text': 'var(--text-secondary)',
});
