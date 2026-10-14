'use strict';
const { fail } = require('./componentPackage.cjs');
const embedded = require('./componentBundle.json');
const { compareVersions } = require('../updateChannels.cjs');

// electron/spotify/latestComponentBundle.cjs — each installation checks the latest published, validated fork bundle.
const repository = 'PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer';
function validateBundle(value) {
  if (value?.schema !== 1 || value.platform !== 'win32-x64' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version || '')) throw fail('SPOTIFY_COMPONENT_MANIFEST_INVALID');
  for (const key of ['spicetify', 'cable']) {
    const pin = value[key];
    if (!pin || !/^\d+\.\d+\.\d+(?:[.\w-]+)?$/.test(pin.version || '') || !/^[a-f0-9]{64}$/.test(pin.sha256 || '')
      || !/^[\w.-]+\.exe$/.test(pin.entry || '') || !String(pin.url).startsWith('https://')) throw fail('SPOTIFY_COMPONENT_MANIFEST_INVALID');
  }
  for (const key of ['entrySha256', 'wrapperSha256']) if (!/^[a-f0-9]{64}$/.test(value.spicetify[key] || '')) throw fail('SPOTIFY_COMPONENT_MANIFEST_INVALID');
  for (const key of ['route', 'capture']) if (!value[key]?.version || !/^[a-f0-9]{64}$/.test(value[key].sha256 || '')) throw fail('SPOTIFY_COMPONENT_MANIFEST_INVALID');
  return value;
}
async function latestComponentBundle({ fetcher = fetch, bundled = embedded } = {}) {
  let release, published;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`,
      { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw Error('release');
    release = await response.json();
    if (release.draft || release.prerelease || !/^folia-hifi-v[\w.-]+$/.test(release.tag_name || '')) throw Error('release');
    const asset = release.assets?.find(item => item.name === 'spotify-wrapper-components.json');
    const url = asset?.browser_download_url || `https://raw.githubusercontent.com/${repository}/${release.tag_name}/electron/spotify/componentBundle.json`;
    const manifest = await fetcher(url, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!manifest.ok) throw Error('manifest');
    published = validateBundle(await manifest.json());
  } catch (error) {
    throw error.code === 'SPOTIFY_COMPONENT_MANIFEST_INVALID' ? error : fail('SPOTIFY_COMPONENT_UPDATE_CHECK_FAILED');
  }
  const bundle = compareVersions(published.version, bundled.version) > 0 ? published : bundled;
  // A new native ABI/source must arrive in a matching Folia build, never reuse an older available binary.
  for (const key of ['route', 'capture']) {
    if (bundle[key].version !== bundled[key].version || bundle[key].sha256 !== bundled[key].sha256) throw fail('SPOTIFY_COMPONENT_APP_UPDATE_REQUIRED');
  }
  return { bundle, checkedAt: Date.now(), release: release.tag_name, publishedVersion: published.version };
}
module.exports = { latestComponentBundle, compareVersions, validateBundle };
