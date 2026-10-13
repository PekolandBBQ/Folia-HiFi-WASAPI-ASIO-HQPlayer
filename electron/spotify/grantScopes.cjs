'use strict';

const { spotifyError } = require('./errors.cjs');

// electron/spotify/grantScopes.cjs: normalize granted permission metadata without exposing tokens.
const error = () => spotifyError('invalid-response', 'invalid-scope');
const REQUIRED_DEVICE_SCOPE = 'user-read-playback-state';
const REQUIRED_PLAYBACK_SCOPE = 'user-modify-playback-state';
const CATALOG_SCOPES = ['user-read-private', 'playlist-read-private', 'playlist-read-collaborative',
    'user-library-read', REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE].sort().join(' ');
function normalizeScope(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > 4096) throw error();
    const tokens = value.split(/ +/).filter(Boolean);
    // RFC6749 scope-token: case-sensitive printable ASCII, excluding quote and backslash.
    if (tokens.some(token => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(token))) throw error();
    return [...new Set(tokens)].sort().join(' ');
}
function mergeGrantedScope(previous, response, { refresh = false } = {}) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw error();
    if (Object.hasOwn(response, 'scope')) {
        if (typeof response.scope !== 'string') throw error();
        return normalizeScope(response.scope); // Explicit narrowing/empty scope replaces, never unions.
    }
    // An old grant with no recorded scope remains unknown. Requested scope is never substituted.
    return refresh ? normalizeScope(previous) : null;
}
module.exports = { REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE, CATALOG_SCOPES, normalizeScope, mergeGrantedScope };
