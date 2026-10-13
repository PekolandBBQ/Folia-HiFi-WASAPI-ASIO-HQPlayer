// Public errors deliberately exclude account identifiers, tokens and upstream response bodies.
const CODES = new Set(['auth-required', 'setup-required', 'unsupported', 'unavailable', 'not-playable', 'network', 'invalid-response']);
function spotifyError(code, reason = code) {
  return Object.assign(new Error(`Spotify: ${reason}`), { code: CODES.has(code) ? code : 'unavailable' });
}
module.exports = { spotifyError };
