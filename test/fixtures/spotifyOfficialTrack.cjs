'use strict';

// Complete synthetic official JSON for cache contracts; no credentials or live API.
const TRACK_ID = 'A'.repeat(22), OTHER_ID = 'B'.repeat(22);
function officialTrack(id = TRACK_ID) {
  const artistId = 'D'.repeat(22), albumId = 'C'.repeat(22);
  const artist = { id: artistId, uri: `spotify:artist:${artistId}`, type: 'artist', name: 'Fixture artist',
    href: `https://api.spotify.com/v1/artists/${artistId}`, external_urls: { spotify: `https://open.spotify.com/artist/${artistId}` } };
  return { id, uri: `spotify:track:${id}`, type: 'track', name: 'Fixture track', duration_ms: 180000,
    is_local: false, is_playable: true, artists: [artist], disc_number: 1, track_number: 2, explicit: false,
    available_markets: ['US', 'GB'], popularity: 50, preview_url: null, external_ids: { isrc: 'FIXTURE123456' },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` }, href: `https://api.spotify.com/v1/tracks/${id}`,
    album: { id: albumId, uri: `spotify:album:${albumId}`, type: 'album', name: 'Fixture album', album_type: 'album',
      total_tracks: 10, release_date: '2026-10-01', release_date_precision: 'day', artists: [artist],
      images: [{ url: 'https://i.scdn.co/image/fixture', height: 640, width: 640 }], available_markets: ['US', 'GB'],
      href: `https://api.spotify.com/v1/albums/${albumId}`, external_urls: { spotify: `https://open.spotify.com/album/${albumId}` } } };
}
module.exports = { officialTrack, TRACK_ID, OTHER_ID };
