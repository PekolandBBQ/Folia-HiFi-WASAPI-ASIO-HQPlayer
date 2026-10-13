'use strict';

// electron/spotify/ownedRouteTrial.cjs: immutable admission for this private validation build; not production qualification.
const VALIDATION_PROFILE = 'folia-r19-owned-route-28000-x64-v1';
function trialArtifact(manifest) {
  return manifest?.productionQualified === false && manifest.trialAuthorized === true
    && manifest.validationProfile === VALIDATION_PROFILE;
}
function trialMachine({ platform, arch, release }) {
  return platform === 'win32' && arch === 'x64' && /^10\.0\.28000(?:\.\d+)?$/.test(release);
}
function admitted(value) {
  return value?.supported === true && (value.productionQualified === true
    || value.trialAuthorized === true && value.validationProfile === VALIDATION_PROFILE);
}
module.exports = { VALIDATION_PROFILE, trialArtifact, trialMachine, admitted };
