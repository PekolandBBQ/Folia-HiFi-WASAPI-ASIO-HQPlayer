// Match HQPlayer's SDM base-clock multipliers without changing the integer rate sent to its API.
export function formatHQPlayerRate(rate: number, sdm: boolean): string {
    if (sdm) for (const base of [32000, 44100, 48000]) {
        const multiplier = rate / base;
        if ([64, 128, 256, 512, 1024, 2048].includes(multiplier)
            || (base === 48000 && [250, 500, 1000, 2000].includes(multiplier))) return `${base / 1000}k x${multiplier}`;
    }
    return rate >= 1000 ? `${rate / 1000} kHz` : `${rate} Hz`;
}
