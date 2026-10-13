'use strict';
const { spotifyError } = require('../../../../electron/spotify/errors.cjs');

// Frozen r18 cableSetup selection validator, retained verbatim for profile rollback compatibility checks.
const FIELDS = ['connectDeviceId', 'captureDeviceId', 'renderDeviceId', 'internal44100Confirmed', 'spotifyOnlyConfirmed', 'defaultsConfirmed'];
function validateSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key))
      || FIELDS.some(key => key.endsWith('Confirmed') ? typeof value[key] !== 'boolean'
        : typeof value[key] !== 'string' || value[key].length > 512 || /[\x00-\x1f\x7f]/.test(value[key])))
    throw spotifyError('invalid-response', 'invalid-cable-selection');
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}
module.exports = { validateSelection };
