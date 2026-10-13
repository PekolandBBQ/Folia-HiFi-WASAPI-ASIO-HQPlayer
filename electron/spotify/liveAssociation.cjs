'use strict';
const { createPlaybackAssociation } = require('./playbackAssociation.cjs');
const { createCatalogObservation } = require('./catalogObservation.cjs');
const { REQUIRED_DEVICE_SCOPE } = require('./grantScopes.cjs');
// electron/spotify/liveAssociation.cjs: main-only composition. Guest callbacks invoke owned_soloist.py through
// the already owned guest runtime channel, honor signal cancellation, and never take renderer leases.
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a?.epoch === b?.epoch && a?.revision === b?.revision;
function requireBinaryWitness(snapshot) {
  const owner = snapshot?.owner;
  if (!owner || !Number.isSafeInteger(owner.uid) || owner.uid <= 0
    || !Number.isSafeInteger(owner.executableDevice) || owner.executableDevice < 0
    || !Number.isSafeInteger(owner.executableInode) || owner.executableInode <= 0
    || !/^[a-f0-9]{64}$/.test(owner.executableSha256 || '')) throw fail('OWNERSHIP_UNKNOWN');
  return snapshot;
}
function createLiveAssociationCandidate({ vault, cooldown, guest, fetcher, now = Date.now, choosePosition, expectedDeviceName }) {
  if (!guest || !['readFresh', 'seekOwnedPaused'].every(k => typeof guest[k] === 'function')) throw fail('OWNERSHIP_UNKNOWN');
  const catalog = createCatalogObservation({ vault, cooldown, fetcher, now });
  let running = false, serial = 0, active, playbackTarget;
  const acquisitions = new Set();
  const unverified = reason => ({ canonicalIdentityVerified: false, accountPlaybackAssociation: 'unverified',
    reason, restoration: 'not-required', evidence: null });
  async function verify({ authorizePausedChallenge = false } = {}) {
    if (running) return unverified('BUSY');
    running = true;
    playbackTarget = undefined;
    const expectedSerial = serial, controller = new AbortController();
    let metadata, association;
    function current() {
      if (expectedSerial !== serial || controller.signal.aborted || !same(metadata, vault.stamp())) throw fail('SESSION_CHANGED');
    }
    try {
      const initial = await vault.grantedScopes();
      if (!Array.isArray(initial.scopes)) return unverified('SCOPES_UNKNOWN');
      if (!initial.scopes.includes(REQUIRED_DEVICE_SCOPE)) return unverified('SCOPE_REQUIRED');
      // A legitimate refresh can revise the grant; settle it BEFORE fixing this probe's stamp.
      if (!await vault.token()) return unverified('AUTH_REQUIRED');
      if (expectedSerial !== serial) throw fail('SESSION_CHANGED');
      metadata = await vault.grantedScopes(); current();
      const readGuest = async () => {
        current(); const snapshot = await guest.readFresh({ signal: controller.signal }); current(); return requireBinaryWitness(snapshot);
      };
      const seekGuest = async request => {
        current(); const reply = await guest.seekOwnedPaused(request, { signal: controller.signal }); current(); return reply;
      };
      association = createPlaybackAssociation({ scopeSnapshot() {
        current(); return metadata;
      }, readCatalogFresh: async () => {
        current(); const snapshot = await catalog.readFresh({ expectedStamp: metadata, signal: controller.signal }); current(); return snapshot;
      }, readOwnedSoloistFresh: readGuest, seekOwnedPaused: seekGuest, now, choosePosition,
        onVerified(target) { current(); playbackTarget = target; } });
      active = { association, controller };
      return await association.verify({ authorizePausedChallenge });
    } catch (error) {
      return unverified(['SESSION_CHANGED', 'AUTH_REQUIRED', 'SCOPES_UNKNOWN', 'SCOPE_REQUIRED', 'RATE_LIMITED',
        'API_FORBIDDEN', 'API_UNAVAILABLE', 'PLAYBACK_UNAVAILABLE'].includes(error?.code) ? error.code : 'PROBE_FAILED');
    } finally {
      controller.abort(); if (active?.controller === controller) active = undefined; running = false;
    }
  }
  return { verify,
    async acquirePlaybackTarget({ signal } = {}) {
      // An account may list the owned device before Spotify has any current playback context.
      // This is only a selection candidate; the PCM client must confirm the selected URI/control.
      const controller = new AbortController(), ownSerial = serial;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      acquisitions.add(controller);
      let stamp;
      const current = () => {
        if (controller.signal.aborted) throw fail('CANCELLED');
        if (ownSerial !== serial || (stamp && !same(stamp, vault.stamp()))) throw fail('SESSION_CHANGED');
      };
      try {
      current();
      const token = await vault.token(); current();
      if (!token) throw fail('AUTH_REQUIRED');
      stamp = vault.stamp();
      const observed = await guest.readFresh({ signal: controller.signal }); current();
      const snapshot = requireBinaryWitness(observed);
      const owner = snapshot.owner;
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.startTicks || '')
          || ![owner.wsPort, owner.zeroConfPort].every(p => Number.isSafeInteger(p) && p > 0 && p < 65536)
          || owner.wsSocketPid !== owner.pid || owner.zeroConfSocketPid !== owner.pid
          || owner.wsSocketStartTicks !== owner.startTicks || owner.zeroConfSocketStartTicks !== owner.startTicks) throw fail('OWNERSHIP_UNKNOWN');
      if (snapshot.authState?.logged_in !== true) throw fail('AUTH_REQUIRED');
      const state = await catalog.readFresh({ expectedStamp: stamp, devicesOnly: true, signal: controller.signal }); current();
      if (!state.user?.id || !Array.isArray(state.devices?.devices)) throw fail('PROTOCOL_INVALID');
      const devices = state.devices.devices;
      const valid = d => typeof d?.id === 'string' && d.id.length > 0 && d.id.length <= 256 && d.is_restricted === false;
      const exact = devices.filter(d => valid(d) && d.id === snapshot.zeroConf?.deviceID);
      const named = typeof expectedDeviceName === 'string' && expectedDeviceName.length > 0 && expectedDeviceName.length <= 256
        ? devices.filter(d => valid(d) && d.name === expectedDeviceName) : [];
      const matches = exact.length ? exact : named;
      if (matches.length !== 1 || devices.filter(d => d.id === matches[0].id).length !== 1) throw fail('DEVICE_ID_UNAVAILABLE');
      return { deviceId: matches[0].id, stamp: { ...stamp }, validUntil: now() + 5000, association: 'selection-candidate' };
      } finally {
        signal?.removeEventListener('abort', abort); acquisitions.delete(controller);
      }
    },
    clear() { serial++; playbackTarget = undefined; for (const controller of acquisitions) controller.abort();
      active?.controller.abort(); active?.association.clear(); } };
}
module.exports = { createLiveAssociationCandidate };
