'use strict';
const { failure } = require('./ownedRouteProtocol.cjs');
const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');

// electron/spotify/ownedRouteAudio.cjs: keep every PCM gate closed until capture, source and full routing proof agree.
function createOwnedRouteAudio({ routeLifecycle, captureHost, beginPausedHoldProof }) {
  return {
    create({ session, controlSession = session, selection, binding, pausedTrackId, selectedTrackId, signal, onFailure, discard = false }) {
      let route, capture, closing, heldPaused = false, captureAttempted = false, preparationComplete = false, started = false;
      let seekRetirement, seekTransaction;
      const own = () => { if (signal?.aborted) throw failure('CANCELLED'); };
      async function stopCapture() {
        if (capture) {
          if (typeof capture.stopVerified !== 'function') throw failure('ROUTE_RESTORE_UNCONFIRMED');
          await capture.stopVerified();
        } else if (captureAttempted) {
          // A failed Open may have reached native code. Verify the exact latest
          // capture's stop (or own-child exit) without permanently closing this
          // provider's reusable host before the next track can enter.
          if (typeof captureHost.verifyStopped === 'function') await captureHost.verifyStopped();
          else await captureHost.close();
        }
        route?.captureStopped();
      }
      return Object.freeze({
        get capture() { return capture; },
        get session() { return session; },
        get selectedTrackId() { return selectedTrackId; },
        get restored() { return route?.released === true; },
        get heldPaused() { return heldPaused; },
        get pausedProofTransferId() { return route?.pausedProofTransferId; },
        get supportsSeekPark() { return route?.supportsSeekPark === true && capture?.supportsSeekPark === true; },
        beginPlayingSeek(transaction) {
          own();
          if (!started || closing || heldPaused || seekRetirement || route?.supportsSeekPark !== true
            || capture?.supportsSeekPark !== true) return null;
          const retirement = capture.beginSeekRetirement(transaction);
          if (!retirement) return null;
          route.publicationStopped(); seekRetirement = retirement; seekTransaction = transaction;
          return retirement;
        },
        async parkForSeek() {
          own();
          if (!seekRetirement || !seekTransaction || closing || heldPaused) throw failure('ROUTE_PROTOCOL_INVALID');
          const receipt = await seekRetirement.park(); own();
          route.captureSeekParked(receipt);
          const sourceObservation = beginPausedHoldProof?.(controlSession);
          try { await route.seekPark({ sourceObservation, seekTransaction, captureParkReceipt: receipt }); own(); }
          finally { sourceObservation?.close(); }
          started = false; preparationComplete = false; heldPaused = true;
        },
        async prepareSelection() {
          if (route || closing || started) throw failure('ROUTE_PROTOCOL_INVALID');
          route = await routeLifecycle.acquire({ session, selection, binding, sourcePaused: true, signal, onFailure,
            sourceDeviceId: selection.deviceId, expectedSourceUri: pausedTrackId == null ? null : `spotify:track:${pausedTrackId}`,
            selectedSourceUri: `spotify:track:${selectedTrackId}` }); own();
          await route.authorizePreparedSelection(); own();
        },
        // Transfer only selection intent; native retains the exact lease and original-role journal.
        async rebindPreparation({ selectedTrackId: nextTrackId, pausedTrackId: previousTrackId, controlSession: nextControlSession }) {
          own();
          if (!route || !heldPaused || capture || closing || typeof route.rebindPreparedSelection !== 'function'
            || previousTrackId !== selectedTrackId || typeof nextControlSession !== 'string')
            throw failure('ROUTE_PROOF_UNCONFIRMED');
          await route.rebindPreparedSelection({ selectedTrackId: nextTrackId, pausedTrackId: previousTrackId }); own();
          selectedTrackId = nextTrackId; controlSession = nextControlSession;
          preparationComplete = false; heldPaused = false;
        },
        async holdExternalSelection(nextTrackId) {
          own();if(!route||closing||route.released)throw failure('ROUTE_PROTOCOL_INVALID');
          route.publicationStopped();await stopCapture();own();route.confirmPaused();
          await route.holdExternalSelection(nextTrackId);own();
          selectedTrackId=nextTrackId;capture=undefined;captureAttempted=false;started=false;
          preparationComplete=false;heldPaused=true;seekRetirement=undefined;seekTransaction=undefined;
        },
        async suspendPaused() {
          own();
          if (!route || closing || route.released) throw failure('ROUTE_PROTOCOL_INVALID');
          if (heldPaused && !seekRetirement) return;
          route.publicationStopped();
          await stopCapture(); own();
          if (typeof route.suspendPaused !== 'function') throw failure('ROUTE_PROOF_UNCONFIRMED');
          // Native independently verifies source quiescence and capture/format release.
          // A stopped JS iterator alone is never a permit to keep the temporary route.
          const sourceObservation = beginPausedHoldProof?.(controlSession);
          try { await route.suspendPaused({ sourceObservation }); own(); }
          finally { sourceObservation?.close(); }
          capture = undefined; captureAttempted = false; started = false; preparationComplete = false; heldPaused = true;
          seekRetirement = undefined; seekTransaction = undefined;
        },
        async resumePreparation(transfer = {}) {
          own();
          if (!route || !heldPaused || closing || typeof route.resumePreparation !== 'function')
            throw failure('ROUTE_PROOF_UNCONFIRMED');
          await route.resumePreparation({ selectedTrackId, ...transfer }); own();
          heldPaused = false;
        },
        async verifyPreparedTargetActive() {
          own(); if (!route || heldPaused || preparationComplete || started || closing) throw failure('ROUTE_PROTOCOL_INVALID');
          await route.verifyPreparedTargetActive(); own();
        },
        async completePreparation() {
          own(); if (!route || heldPaused || preparationComplete || started || closing) throw failure('ROUTE_PROTOCOL_INVALID');
          await route.completePreparedSelection(); own(); preparationComplete = true;
        },
        async start({ signal: captureSignal = signal, onFailure: captureFailure = onFailure, positionIntentId } = {}) {
          own(); if (!route || !preparationComplete || started || closing || discard) throw failure('ROUTE_PROOF_UNCONFIRMED');
          if (captureSignal?.aborted) throw failure('CANCELLED');
          started = true;
          // A paused source may have no session on CABLE yet. Only the explicit native bootstrap contract
          // may omit that one observation; endpoint, format, process and foreign-writer guards remain native checks.
          route.captureOpening();
          captureAttempted = true;
          capture = await captureHost.open({ session, ...selection, ...(seekRetirement ? { seekReuse: seekRetirement } : {}), signal: captureSignal, onFailure: captureFailure, bootstrapMode: 'paused-source',
            bootstrapDelivery: 'buffer', expectedSpotifyStartTimeUtcTicks: binding.expectedSpotifyStartTimeUtcTicks }); own();
          if (typeof capture.stopVerified !== 'function' || typeof capture.promote !== 'function') throw failure('ROUTE_PROOF_UNCONFIRMED');
          route.capturePrepared();
          // The running silent format holder is a distinct exact session. Bind its own-child
          // evidence atomically with the interval baseline before source activity or PCM admission.
          if (typeof capture.ownedSilentRenderLease !== 'function') throw failure('ROUTE_PROOF_UNCONFIRMED');
          await route.armCaptureInterval(capture.ownedSilentRenderLease()); own();
          route.captureStarting();
          await capture.start(positionIntentId ? { positionIntentId } : undefined); own();
          await route.authorizeResume(); own();
        },
        verifyActive: () => route.verifyActive(),
        async promote() {
          own(); if (discard) throw failure('ROUTE_PROTOCOL_INVALID');
          const value = await capture.promote(); own(); return value;
        },
        confirmPaused() { route?.confirmPaused(); },
        publicationStarted() { own(); route.publicationStarted(); seekRetirement = undefined; seekTransaction = undefined; },
        publicationStopped() { route?.publicationStopped(); },
        stopCapture,
        close() {
          if (route?.released === true) return Promise.resolve();
          if (closing) return closing;
          route?.publicationStopped();
          closing = (async () => { await stopCapture(); await route?.release(); })();
          void closing.catch(error => { if (isRetryableRouteCleanup(error)) closing = null; });
          return closing;
        },
      });
    },
  };
}
module.exports = { createOwnedRouteAudio };
