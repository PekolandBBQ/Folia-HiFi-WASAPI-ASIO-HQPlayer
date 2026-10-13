'use strict';

// electron/spotify/officialTrackSnapshot.cjs: retain an isolated, bounded complete
// official catalog object. Unknown/private fields cause a miss, never projection.
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const optional = (value, key, check) => !Object.hasOwn(value, key) || check(value[key]);
const url = value => text(value) && /^https:\/\//.test(value);
const urls = value => keys(value, ['spotify']) && optional(value, 'spotify', url);
const markets = value => Array.isArray(value) && value.length <= 256
  && value.every(item => typeof item === 'string' && /^[A-Z]{2}$/.test(item));
const identity = (value, type) => value.type === type && validId(value.id) && value.uri === `spotify:${type}:${value.id}`;
const linked = value => keys(value, ['id', 'uri', 'type', 'href', 'external_urls']) && identity(value, 'track')
  && optional(value, 'href', url) && optional(value, 'external_urls', urls);
const artists = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(artist => keys(artist, ['id', 'uri', 'type', 'name', 'href', 'external_urls'])
    && identity(artist, 'artist') && text(artist.name) && optional(artist, 'href', url) && optional(artist, 'external_urls', urls));
const images = value => Array.isArray(value) && value.length <= 32 && value.every(image => keys(image, ['url', 'height', 'width'])
  && url(image.url) && optional(image, 'height', n => n === null || integer(n))
  && optional(image, 'width', n => n === null || integer(n)));
const restrictions = value => keys(value, []);
const album = value => keys(value, ['album_type', 'total_tracks', 'available_markets', 'external_urls', 'href', 'id', 'images',
  'name', 'release_date', 'release_date_precision', 'restrictions', 'type', 'uri', 'artists'])
  && identity(value, 'album') && text(value.name) && images(value.images) && artists(value.artists)
  && ['album', 'single', 'compilation'].includes(value.album_type) && integer(value.total_tracks)
  && typeof value.release_date === 'string' && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value.release_date)
  && ['year', 'month', 'day'].includes(value.release_date_precision)
  && optional(value, 'available_markets', markets) && optional(value, 'external_urls', urls)
  && optional(value, 'href', url) && optional(value, 'restrictions', restrictions);

function plainJson(value) {
  let remaining = 8192;
  const visit = (item, depth) => {
    if (--remaining < 0 || depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 2048;
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)) return false;
    const ownKeys = Reflect.ownKeys(item);
    if (Array.isArray(item) && ownKeys.length !== item.length + 1) return false;
    return ownKeys.every(key => {
      if (typeof key !== 'string' || Array.isArray(item) && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return Object.hasOwn(descriptor, 'value') && (descriptor.enumerable || Array.isArray(item) && key === 'length')
        && visit(descriptor.value, depth + 1);
    });
  };
  return visit(value, 0);
}

// Validate the complete schema before copying it. No player position, device,
// account object, grant or arbitrary response field can enter this snapshot.
function snapshotOfficialTrack(value) {
  if (!plainJson(value) || !keys(value, ['album', 'artists', 'available_markets', 'disc_number', 'duration_ms', 'explicit', 'external_ids',
    'external_urls', 'href', 'id', 'is_playable', 'linked_from', 'restrictions', 'name', 'popularity', 'preview_url',
    'track_number', 'type', 'uri', 'is_local']) || !identity(value, 'track') || !text(value.name)
    || value.is_local !== false || value.is_playable !== true || !integer(value.duration_ms)
    || value.duration_ms < 1 || value.duration_ms > 3600000 || !artists(value.artists) || !album(value.album)
    || !integer(value.disc_number) || !integer(value.track_number) || typeof value.explicit !== 'boolean'
    || !optional(value, 'available_markets', markets) || !optional(value, 'external_urls', urls)
    || !optional(value, 'href', url) || !optional(value, 'linked_from', linked)
    || !optional(value, 'restrictions', restrictions)
    || !optional(value, 'popularity', n => integer(n) && n <= 100)
    || !optional(value, 'preview_url', item => item === null || url(item))
    || !optional(value, 'external_ids', item => keys(item, ['isrc', 'ean', 'upc']) && Object.values(item).every(text))) return null;
  // JSON is already supplied by the official API. The byte bound also covers
  // nested arrays; no getters/prototypes or new persistent cache are retained.
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > 65536) return null;
  const copy = JSON.parse(encoded);
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
}

module.exports = { snapshotOfficialTrack };
