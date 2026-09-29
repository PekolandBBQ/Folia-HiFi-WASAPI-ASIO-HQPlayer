// Real HQPlayer catalogs and a mode-specific staged settings choice.
export type HQPlayerDspSettings = { mode: number; filter: string; shaper: string; rate: number };
export type HQPlayerDspCatalog = {
    state: { mode: number; filter: number; shaper: number; rate: number; state: number };
    modes: { index: number; name: string; value: number }[];
    catalogs: Record<number, { filters: { index: number; name: string }[]; shapers: { index: number; name: string }[]; rates: { index: number; rate: number }[] }>;
    pending: HQPlayerDspSettings | null;
    deviceControlAvailable: boolean;
};
