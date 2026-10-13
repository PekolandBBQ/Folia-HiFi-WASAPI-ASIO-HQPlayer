const fs = require('node:fs');
const path = require('node:path');
const { NCSPOT_CLIENT_ID } = require('./catalogLogin.cjs');
const { spotifyError } = require('./errors.cjs');

// Public OAuth configuration only; tokens and client secrets are never read from this file.
function validateClientSettings(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw spotifyError('invalid-response', 'invalid-client-settings');
  const catalogClientId = saved.clientId;
  const catalogRedirectUri = saved.redirectUri;
  if (typeof catalogClientId !== 'string' || !/^[a-f0-9]{32}$/.test(catalogClientId)) throw spotifyError('invalid-response', 'invalid-client-id');
  if (typeof catalogRedirectUri !== 'string' || catalogRedirectUri.length > 256) throw spotifyError('invalid-response', 'invalid-redirect-uri');
  let url;
  try { url = new URL(catalogRedirectUri); } catch { throw spotifyError('invalid-response', 'invalid-redirect-uri'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash
    || !/^\/[a-zA-Z0-9/_-]+$/.test(url.pathname)) throw spotifyError('invalid-response', 'invalid-redirect-uri');
  return { catalogClientId, catalogRedirectUri };
}
function readClientSettings(directory, environment = process.env) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(directory, 'client.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw spotifyError('invalid-response', 'invalid-client-settings'); }
  return validateClientSettings({ clientId: environment.FOLIA_SPOTIFY_CLIENT_ID || saved?.clientId || NCSPOT_CLIENT_ID,
    redirectUri: environment.FOLIA_SPOTIFY_REDIRECT_URI || saved?.redirectUri || 'http://127.0.0.1:8989/login' });
}
async function writeClientSettings(directory, input, environment = process.env) {
  if (environment.FOLIA_SPOTIFY_CLIENT_ID || environment.FOLIA_SPOTIFY_REDIRECT_URI) throw spotifyError('unavailable', 'client-settings-managed');
  const settings = validateClientSettings(input);
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'client.json');
  await fs.promises.writeFile(file + '.tmp', JSON.stringify({ clientId: settings.catalogClientId, redirectUri: settings.catalogRedirectUri }), { mode: 0o600 });
  await fs.promises.rename(file + '.tmp', file);
  return settings;
}
module.exports = { readClientSettings, writeClientSettings, validateClientSettings };
