import { describe, expect, it } from 'vitest';
import { normalizeSpotifySong, normalizeSpotifyCollection, normalizeSpotifyPage, normalizeSpotifyUser } from '@/services/onlineMusic/spotifyNormalize';
import { spotifyProvider } from '@/services/onlineMusic/spotifyProvider';

// Source identity and unavailable playback must stay truthful while the local preview is unfinished.
const track = { id: '0123456789012345678901', name: 'Song', type: 'track', duration_ms: 123000,
  artists: [{ id: 'artist', name: 'Artist' }], album: { id: 'album', name: 'Album', images: [{ url: 'https://i.scdn.co/example' }] } };
describe('Spotify Omni normalization', () => {
  it('loads the explicitly marked local queue without assigning it an official playlist identity', () => {
    const local = { id: 'folia-local-queue', providerId: 'spotify', type: 'playlist', name: 'Local queue', providerData: { localQueue: true } };
    expect(normalizeSpotifyPage({ items: [local], total: 1, next: null }, 0, normalizeSpotifyCollection).items).toEqual([local]);
    expect(normalizeSpotifyCollection(local).metadataSource).toBeUndefined();
    expect(() => normalizeSpotifyCollection({ ...local, providerData: {} })).toThrow('collection unavailable');
  });
  it('preserves source identity and already-normalized cached songs', () => {
    const song = normalizeSpotifySong(track); expect(song.sourceRef).toMatchObject({ providerId: 'spotify', mediaId: track.id });
    expect(song.durationMs).toBe(123000); expect(normalizeSpotifySong(song)).toBe(song);
  });
  it('accepts current and legacy playlist envelopes and advances past unavailable entries', () => {
    const page = normalizeSpotifyPage({ items: [{ item: track }, { track }, { item: null }, { item: { ...track, type: 'episode' } }, { item: { ...track, is_local: true } }], next: 'next', total: 6 }, 0, normalizeSpotifySong, true);
    expect(page.items).toHaveLength(2); expect(page.nextOffset).toBe(5); expect(page.hasMore).toBe(true);
  });
  it('preserves normalized collections and validates missing pages', () => {
    const collection = normalizeSpotifyCollection({ id: track.id, name: 'Playlist', items: { total: 5 } });
    expect(collection.trackCount).toBe(5); expect(normalizeSpotifyCollection(collection)).toBe(collection);
    expect(() => normalizeSpotifyPage({}, 0, normalizeSpotifySong)).toThrow('page unavailable');
  });
  it('advances native rootlist offsets across filtered folders and local tracks', () => {
    const page = normalizeSpotifyPage({ items: [], consumed: 20, next: true, total: 40 }, 0, normalizeSpotifySong, true);
    expect(page.nextOffset).toBe(20); expect(page.hasMore).toBe(true);
  });
  it('requires the desktop runtime for audio and exposes native Spotify lyrics through Omni', async () => {
    expect(spotifyProvider.capabilities.playback).toBe(true); expect(spotifyProvider.capabilities.lyrics).toBe(true);
    await expect(spotifyProvider.playback!.getAudioSource(normalizeSpotifySong(track), 'hires')).rejects.toMatchObject({ code: 'unavailable' });
    expect(normalizeSpotifyUser({ id: 'account', product: 'premium' })?.vipType).toBe(1);
    expect(normalizeSpotifyUser(null)).toBeNull();
  });
});
