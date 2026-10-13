import type { UnifiedSong } from '../../types';
// A cached randomized nine-song mosaic; only verified liked songs can supply tiles.
export async function spotifyLikedCover(user: string, songs: UnifiedSong[]): Promise<string | undefined> {
    const choices = songs.filter(song => song.album?.coverUrl).map(song => ({ id: String(song.id), url: song.album!.coverUrl! }));
    if (!choices.length) return undefined;
    const key = `folia.spotify.liked-cover.v1.${user}`;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (Array.isArray(saved?.tiles) && saved.tiles.length === Math.min(9, choices.length)
            && saved.tiles.every((tile: { id: string; url: string }) => choices.some(song => song.id === tile.id && song.url === tile.url))
            && saved?.image?.startsWith('data:image/jpeg')) return saved.image;
    } catch { /* A missing or full cache must not block the library. */ }
    const shuffled = [...choices];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const tiles = shuffled.slice(0, 9);
    const images = (await Promise.all(tiles.map(tile => new Promise<HTMLImageElement | null>(resolve => {
        const image = new Image(); image.crossOrigin = 'anonymous';
        const timer = setTimeout(() => { image.src = ''; resolve(null); }, 6000);
        image.onload = () => { clearTimeout(timer); resolve(image); };
        image.onerror = () => { clearTimeout(timer); resolve(null); }; image.src = tile.url;
    })))).filter((value): value is HTMLImageElement => Boolean(value));
    if (!images.length) return undefined;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 600;
    const context = canvas.getContext('2d'); if (!context) return undefined;
    for (let i = 0; i < 9; i++) {
        const image = images[i % images.length], side = Math.min(image.naturalWidth, image.naturalHeight);
        context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, (i % 3) * 200, Math.floor(i / 3) * 200, 200, 200);
    }
    let image: string;
    try { image = canvas.toDataURL('image/jpeg', 0.87); }
    catch { return undefined; }
    if (images.length === tiles.length) {
        try { localStorage.setItem(key, JSON.stringify({ tiles, image })); }
        catch { /* A full cache must not hide a successfully generated cover. */ }
    }
    return image;
}
