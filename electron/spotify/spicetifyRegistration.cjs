'use strict';
const { registerCableSpotify } = require('./cableService.cjs');
const { createSpicetifyService } = require('./spicetify/runtime/createSpicetifyService.cjs');

// electron/spotify/spicetifyRegistration.cjs: this separate candidate fixes the source constructor in trusted main code.
function registerSpicetify({ createService = createSpicetifyService, ...options }) {
  // Constructor injection is main-process-only and mirrors the existing registration test seam.
  // No renderer request, account setting, environment value or transport frame selects source authority.
  return registerCableSpotify({ ...options, createService });
}
module.exports = { registerSpicetify };
