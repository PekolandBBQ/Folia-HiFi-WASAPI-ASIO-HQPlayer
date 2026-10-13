'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const bundle = require('../../electron/spotify/componentBundle.json');
// Assemble only the pinned native pair. Spotify assets and user profiles never ship.
async function prepareWrapperResources({ source, destination, preview = false, localValidation = false }) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'spotify-route/component.json'), 'utf8'));
  if (!preview && !localValidation && manifest.productionQualified !== true) throw Object.assign(Error('WRAPPER_NOT_RELEASE_QUALIFIED'), { code: 'WRAPPER_NOT_RELEASE_QUALIFIED' });
  if (localValidation && (manifest.trialAuthorized !== true
    || manifest.validationProfile !== require('../../electron/spotify/ownedRouteTrial.cjs').VALIDATION_PROFILE
    || manifest.builtFor !== 'win-x64')) throw Error('WRAPPER_LOCAL_VALIDATION_PROFILE_MISMATCH');
  if (manifest.version !== bundle.route.version || manifest.sha256 !== bundle.route.sha256) throw Error('WRAPPER_ROUTE_PIN_MISMATCH');
  const files = ['spotify-route/component.json', 'spotify-route/folia-route-service.exe', 'spotify-cable/folia-capture.exe'];
  const contents = await Promise.all(files.map(name => fs.readFile(path.join(source, name))));
  if (manifest.lengthBytes !== contents[1].length) throw Error('WRAPPER_ROUTE_LENGTH_MISMATCH');
  const hash = data => createHash('sha256').update(data).digest('hex');
  if (hash(contents[1]) !== bundle.route.sha256 || hash(contents[2]) !== bundle.capture.sha256) throw Error('WRAPPER_NATIVE_PIN_MISMATCH');
  // Creating a new destination prevents silently replacing an accepted local package.
  await fs.mkdir(destination);
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const file = path.join(destination, files[i]); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents[i], { flag: 'wx' });
    entries.push({ name: files[i], bytes: contents[i].length, sha256: hash(contents[i]) });
  }
  const receipt = { schema: 1, bundleVersion: bundle.version, preview, localValidation,
    productionQualified: manifest.productionQualified === true, validationProfile: manifest.validationProfile, entries };
  await fs.writeFile(path.join(destination, 'assembly.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
module.exports = { prepareWrapperResources };
