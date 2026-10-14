'use strict';
const { failure, preflight, requireLease, rawPolicyValue } = require('./ownedRouteProtocol.cjs');
const { requireOwnedSilentRenderLease } = require('./cableCaptureProtocol.cjs');
const { retainedCleanupFailure, isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');
const { captureSeekReceipt } = require('./captureSeekReceipt.cjs');

// electron/spotify/ownedRouteLifecycle.cjs: serialize temporary routing ownership and retain every failed restoration.
function createOwnedRouteLifecycle({ host, heartbeatMs = 4000, onDiagnostic = () => {} } = {}) {
  let queue = Promise.resolve(), generation = 0, current, blocked, closed = false, closing;
  const serialize = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
  const payload = record => ({ session: record.session, generation: record.generation, leaseId: record.leaseId });
  function diagnostic(phase, record, errorCode, terminal) {
    try { onDiagnostic({ phase, session: record?.session, generation: record?.generation, errorCode,
      ready: phase === 'active', exactOriginalRolesRestored: phase === 'restored',
      ...(terminal ? { observedDefaultsChanged: terminal.observedDefaultsChanged, globalDefaultsWritten: terminal.globalDefaultsWritten } : {}) }); } catch {}
  }
  function own(record) {
    if (record.rebindFailed) throw failure('ROUTE_PROOF_UNCONFIRMED');
    if (current !== record || record.releasing || blocked || closed || record.signal?.aborted) throw blocked || failure('CANCELLED');
  }
  function sameSelection(a, b) { return a.deviceId === b.deviceId && a.captureDeviceId === b.captureDeviceId && a.renderDeviceId === b.renderDeviceId; }
  function notify(record, error) { try { Promise.resolve(record.onFailure?.(error)).catch(() => {}); } catch {} }
  // A failed restore stays in the ownership barrier. No next lease may mask it.
  async function restore(record) {
    if (!record) return;
    if (record.released) return;
    if (record.restoreFailed && !isRetryableRouteCleanup(blocked)) throw blocked || failure('ROUTE_RESTORE_UNCONFIRMED');
    record.restoreRequested = true;
    // The composed helper must establish quiescence independently, including its one bounded recovery.
    // An unconfirmed main-process Pause is neither a restore permit nor a reason to disable that proof path.
    clearTimeout(record.timer); record.releasing = true;
    try {
      const value = await host.request('release', payload(record));
      const lease = requireLease(value, record, 'restored');
      if (value.state !== 'restored' || value.exactOriginalRolesRestored !== true || value.globalDefaultsWritten !== false
        || typeof value.observedDefaultsChanged !== 'boolean'
        || JSON.stringify(lease.originalRoles) !== JSON.stringify(record.originalRoles)) throw failure('ROUTE_RESTORE_UNCONFIRMED');
      host.confirmReleased?.({ session: record.session, generation: record.generation });
      record.released = true; if (current === record) { current = null; blocked = null; }
      diagnostic('restored', record, undefined, value);
    } catch (error) {
      record.restoreFailed = true;
      blocked = retainedCleanupFailure(error?.retryableCleanupReceipt, record) || failure('ROUTE_RESTORE_UNCONFIRMED');
      Object.assign(blocked, { cause: error, nativeCode: error.nativeCode || error.code, failureCode: error.failureCode, stage: 'route-restore' });
      // A confirmed pre-write recovery failure still owns its exact native
      // lease. Keep only that owner's liveness until an explicit retry; stopping
      // its heartbeat would turn a recoverable source outage into idle shutdown.
      if (isRetryableRouteCleanup(blocked) && !closed) heartbeat(record);
      diagnostic('failed', record, blocked.code); notify(record, blocked); throw blocked;
    }
  }
  function heartbeat(record) {
    record.timer = setTimeout(() => {
      void serialize(async () => {
        if (current !== record || record.released || closed) return;
        const retainedRecovery = record.releasing && record.restoreFailed && isRetryableRouteCleanup(blocked);
        if (record.releasing && !retainedRecovery) return;
        try {
          const value = await host.request('heartbeat', payload(record));
          if (!value.lease || value.lease.session !== record.session || value.lease.generation !== record.generation
            || value.lease.leaseId !== record.leaseId || value.state === 'recoveryRequired'
            || record.suspended && (value.state !== 'pausedHeld' || value.ready !== false
              || value.intervalArmed !== false || value.intervalId != null || value.intervalEpoch !== record.intervalEpoch))
            throw failure('ROUTE_LEASE_LOST');
          if (retainedRecovery) {
            // This proves continued ownership only. It cannot prove a paused
            // source, publish PCM, clear recovery, or start restoration writes.
            if (!['heldPaused', 'active', 'preparedSelection', 'pausedHeld'].includes(value.lease.state)
              || value.state !== value.lease.state || value.ready !== false)
              throw failure('ROUTE_LEASE_LOST');
            requireLease(value, record, value.lease.state);
          }
          heartbeat(record);
        } catch (error) {
          // A failed recovery heartbeat is not an instruction to retry release.
          // Keep a hard ownership barrier if exact liveness is lost.
          if (retainedRecovery) blocked = failure('ROUTE_RESTORE_UNCONFIRMED');
          notify(record, failure(error?.code));
        }
      }).catch(() => {});
    }, heartbeatMs);
    record.timer.unref?.();
  }
  return {
    offer() { return host.componentOffer?.() || Promise.resolve({ trialAvailable: false }); },
    pcmStopped(session, expectedGeneration) {
      const record = current;
      return record?.session === session && record.generation === expectedGeneration && record.publicationClosed === true
        && ['not-requested', 'prepared', 'stopped'].includes(record.captureStage);
    },
    seekParkEvidence(session, expectedGeneration, seekTransaction, seekToken) {
      const record = current, proof = record?.captureParkReceipt;
      return record?.session === session && record.generation === expectedGeneration && record.publicationClosed === true
        && record.captureStage === 'seek-parked' && proof?.seekTransaction === seekTransaction && proof.seekToken === seekToken
        && performance.now() - record.captureParkReceivedAt < 5000 ? proof : null;
    },
    captureHelperExited() {
      if (current) { current.captureStage = 'stopped'; current.publicationClosed = true; current.captureParkReceipt = null; }
    },
    setTrialEnabled(value) { return host.setTrialEnabled(value); },
    async availability() {
      if (blocked || current?.rebindFailed) return { supported: false, productionQualified: false, code: blocked?.code || 'ROUTE_PROOF_UNCONFIRMED' };
      if (current?.restoreRequested && !current.safeToRestore)
        return { supported: false, productionQualified: false, code: 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' };
      return host.capabilities();
    },
    recoverBeforePlay({ signal } = {}) {
      return serialize(async () => {
        if (signal?.aborted) throw failure('CANCELLED');
        if (!blocked) return;
        if (!current || !isRetryableRouteCleanup(blocked)) throw blocked;
        // Only a new active request retries this exact retained pre-write owner.
        // No new inspection, route apply or status-side mutation is introduced.
        await restore(current);
        if (signal?.aborted) throw failure('CANCELLED');
      });
    },
    inspect(selection) {
      return serialize(async () => {
        if (blocked || closed) throw blocked || failure('ROUTE_HELPER_CLOSED');
        if (current) {
          const record = current; own(record);
          if (!sameSelection(record.selection, selection) || !record.suspended || record.seekParked
            || !record.publicationClosed || record.captureStage !== 'stopped') throw failure('ROUTE_PROOF_UNCONFIRMED');
          const value = await host.request('validateHeld', { ...payload(record), intervalEpoch: record.intervalEpoch,
            sourceDeviceId: selection.deviceId, captureDeviceId: selection.captureDeviceId, renderDeviceId: selection.renderDeviceId });
          own(record); requireLease(value, record, 'pausedHeld');
          if (value.state !== 'pausedHeld' || value.code !== 'HELD_ROUTE_VALIDATED' || value.ready !== false
            || value.intervalArmed !== false || value.intervalId != null || value.intervalEpoch !== record.intervalEpoch)
            throw failure('ROUTE_PROOF_UNCONFIRMED');
          return { binding: record.binding, held: true, sourcePaused: true };
        }
        let value;
        try { value = await host.request('inspect', { captureDeviceId: selection.captureDeviceId, renderDeviceId: selection.renderDeviceId }); }
        catch (error) { throw error?.noPolicyWrites && error.failureCode ? failure(error.failureCode) : error; }
        return { binding: preflight(value.inspection, selection), held: false, sourcePaused: value.inspection.sourcePaused };
      });
    },
    acquire({ session, selection, binding, sourcePaused, sourceDeviceId, expectedSourceUri, selectedSourceUri, signal, onFailure } = {}) {
      return serialize(async () => {
        if (blocked || closed || signal?.aborted) throw blocked || failure('CANCELLED');
        if (current) throw failure('ROUTE_BUSY');
        if (sourcePaused !== true) throw failure('ROUTE_PROOF_UNCONFIRMED');
        const trackUri = value => typeof value === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(value);
        if (sourceDeviceId !== selection.deviceId || typeof sourceDeviceId !== 'string' || !sourceDeviceId
          || sourceDeviceId.length > 256 || /[\u0000-\u001f\u007f]/.test(sourceDeviceId)
          || expectedSourceUri !== null && !trackUri(expectedSourceUri) || !trackUri(selectedSourceUri)) throw failure('ROUTE_PROTOCOL_INVALID');
        if (!Array.isArray(binding?.expectedOriginalRoles) || binding.expectedOriginalRoles.length !== 2
          || binding.expectedOriginalRoles.some((entry, index) => entry?.role !== index || !rawPolicyValue(entry.original)))
          throw failure('ROUTE_PROTOCOL_INVALID');
        const record = { session, generation: ++generation, selection: { ...selection }, binding, signal, onFailure, safeToRestore: true,
          originalRoles: binding.expectedOriginalRoles.map(entry => ({ ...entry })),
          captureStage: 'not-requested', publicationClosed: true, intervalEpoch: 1, sourceEpoch: 1, selectedSourceUri };
        // Mark ownership before the command: timeout may follow a successful native setter.
        current = record;
        try {
          const value = await host.request('acquire', { ...payload(record), captureDeviceId: selection.captureDeviceId,
            renderDeviceId: selection.renderDeviceId, expectedSpotifyProcessId: binding.expectedSpotifyProcessId,
            expectedSpotifyStartTimeUtcTicks: binding.expectedSpotifyStartTimeUtcTicks, sourcePaused: true,
            sourceDeviceId, expectedSourceUri });
          if (value.state === 'closed' && value.code === 'NO_POLICY_WRITES' && value.noPolicyWrites === true)
            throw Object.assign(failure('NO_POLICY_WRITES'), { noPolicyWrites: true, failureCode: value.failureCode });
          if (value.state === 'restored') throw Object.assign(failure('ROUTE_PROOF_UNCONFIRMED'), { restoreReceipt: value, failureCode: value.failureCode });
          const lease = requireLease(value, record, 'heldPaused');
          record.leaseId = lease.leaseId; record.originalRoles = lease.originalRoles.map(entry => ({ ...entry }));
          if (value.state !== 'heldPaused' || value.ready !== false || value.intervalArmed === true) throw failure('ROUTE_PROTOCOL_INVALID');
          if (signal?.aborted || closed) { await restore(record); throw failure('CANCELLED'); }
          diagnostic('held-paused', record);
          record.boundedSeekPark = (await host.capabilities()).boundedSeekPark === true;
          heartbeat(record);
          return Object.freeze({
            binding: Object.freeze({ ...binding }), generation: record.generation,
            get released() { return record.released === true; },
            get suspended() { return record.suspended === true; },
            get intervalEpoch() { return record.intervalEpoch; },
            get pausedProofTransferId() { return record.pausedProofTransferId; },
            get supportsSeekPark() { return record.boundedSeekPark === true; },
            get seekParked() { return record.seekParked === true; },
            captureSeekParked(receipt) {
              own(record);
              if (!record.publicationClosed || record.captureStage !== 'starting' || !record.intervalId)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.captureParkReceipt = captureSeekReceipt(receipt, { session: record.session });
              record.captureParkReceivedAt = performance.now(); record.captureStage = 'seek-parked';
            },
            captureOpening() { own(record); record.captureStage = 'opening'; },
            capturePrepared() { own(record); record.captureStage = 'prepared'; },
            captureStarting() { own(record); record.captureStage = 'starting'; },
            captureStopped() { if (current === record) { record.captureStage = 'stopped'; record.captureParkReceipt = null; } },
            publicationStarted() { own(record); record.publicationClosed = false; record.seekTransaction = null; record.captureParkReceipt = null; },
            publicationStopped() { if (current === record) record.publicationClosed = true; },
            authorizePreparedSelection() { return serialize(async () => {
              own(record);
              if (record.preparationStage || record.captureStage !== 'not-requested' || !record.publicationClosed)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.preparationStage = 'authorizing'; record.safeToRestore = false;
              const value = await host.request('authorizePreparedSelection', { ...payload(record), selectedSourceUri: record.selectedSourceUri });
              own(record); requireLease(value, record, 'preparedSelection');
              if (value.state !== 'preparedSelection' || value.preparedSelectionAuthorized !== true || value.ready !== false || value.resumeAuthorized === true
                || value.intervalArmed === true || value.code !== 'PREPARED_SELECTION_AUTHORIZED') throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.preparationStage = 'authorized';
            }); },
            verifyPreparedTargetActive() { return serialize(async () => {
              own(record);
              if (record.preparationStage !== 'authorized' || record.captureStage !== 'not-requested' || !record.publicationClosed)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              const value = await host.request('verifyPreparedTargetActive', { ...payload(record), selectedSourceUri: record.selectedSourceUri,
                intervalEpoch: record.intervalEpoch });
              own(record); requireLease(value, record, 'preparedSelection');
              if (value.state !== 'preparedSelection' || value.preparedTargetActive !== true || value.ready !== false
                || value.resumeAuthorized === true || value.intervalArmed === true || value.intervalId != null
                || value.intervalEpoch !== record.intervalEpoch || value.code !== 'PREPARED_TARGET_ACTIVE')
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.preparationStage = 'target-observed';
            }); },
            completePreparedSelection() { return serialize(async () => {
              own(record);
              if (record.preparationStage !== 'target-observed' || !['not-requested', 'seek-parked'].includes(record.captureStage) || !record.publicationClosed)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              const value = await host.request('completePreparedSelection', { ...payload(record), intervalEpoch: record.intervalEpoch });
              own(record); requireLease(value, record, 'heldPaused');
              if (value.state !== 'heldPaused' || value.preparedSelectionCompleted !== true || value.ready !== false || value.resumeAuthorized === true
                || value.intervalArmed === true || value.code !== 'PREPARED_SELECTION_COMPLETED') throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.preparationStage = 'completed'; record.safeToRestore = true;
            }); },
            armCaptureInterval(ownedSilentRenderLease) { return serialize(async () => {
              own(record); if (record.preparationStage !== 'completed' || record.intervalId) throw failure('ROUTE_PROTOCOL_INVALID');
              let proof;
              try { proof = requireOwnedSilentRenderLease(ownedSilentRenderLease, { session: record.session,
                generation: ownedSilentRenderLease?.captureGeneration, renderDeviceId: record.selection.renderDeviceId,
                processId: ownedSilentRenderLease?.processId }); }
              catch { throw failure('ROUTE_PROTOCOL_INVALID'); }
              const value = await host.request('armCaptureInterval', { ...payload(record), ownedSilentRenderLease: proof });
              own(record); requireLease(value, record, 'heldPaused');
              if (value.state !== 'heldPaused' || value.ready !== false || value.intervalArmed !== true
                || value.intervalIsolated !== true || value.intervalGeneration !== record.generation || value.intervalEpoch !== record.intervalEpoch
                || typeof value.intervalId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.intervalId)) throw failure('ROUTE_PROTOCOL_INVALID');
              record.intervalId = value.intervalId;
            }); },
            authorizeResume() { return serialize(async () => {
              own(record); if (!record.intervalId) throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.safeToRestore = false;
              const value = await host.request('authorizeResume', { ...payload(record), captureStarted: true, monitorGainZero: true, selectedSourceUri: record.selectedSourceUri });
              own(record); requireLease(value, record, 'resumeAuthorized');
              if (value.state !== 'resumeAuthorized' || value.resumeAuthorized !== true || value.ready !== false
                || value.intervalArmed !== true || value.intervalIsolated !== true
                || value.intervalGeneration !== record.generation || value.intervalEpoch !== record.intervalEpoch || value.intervalId !== record.intervalId)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              diagnostic('resume-authorized', record);
            }); },
            verifyActive() { return serialize(async () => {
              own(record); const value = await host.request('status', payload(record)); own(record);
              requireLease(value, record, 'active');
              if (value.state !== 'active' || value.ready !== true || value.intervalIsolated !== true
                || value.intervalGeneration !== record.generation || value.intervalEpoch !== record.intervalEpoch || value.intervalArmed !== true
                || value.intervalId !== record.intervalId) throw failure('ROUTE_PROOF_UNCONFIRMED');
              diagnostic('active', record);
            }); },
            seekPark({ sourceObservation, seekTransaction, captureParkReceipt: receipt } = {}) { return serialize(async () => {
              own(record);
              if (!record.boundedSeekPark || record.suspended || record.seekParked || !record.safeToRestore
                || record.captureStage !== 'seek-parked' || !record.publicationClosed || record.preparationStage !== 'completed'
                || receipt?.seekToken !== record.captureParkReceipt?.seekToken || receipt?.seekTransaction !== seekTransaction)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              const capabilities = await host.capabilities(); own(record);
              const reusePauseObservation = capabilities.boundedPausedHoldObservation === true && sourceObservation?.isCurrent() === true;
              const value = await host.request('seekPark', { ...payload(record), intervalEpoch: record.intervalEpoch,
                seekTransaction, captureParkReceipt: record.captureParkReceipt, ...(reusePauseObservation ? { reusePauseObservation: true } : {}) });
              own(record); requireLease(value, record, 'seekParked');
              if (value.state !== 'seekParked' || value.code !== 'SEEK_ROUTE_PARKED' || value.ready !== false
                || value.seekParked !== true || value.intervalArmed !== false || value.intervalId != null
                || value.intervalEpoch !== record.intervalEpoch || value.resumeAuthorized === true
                || typeof value.seekRouteToken !== 'string' || !/^[a-f0-9-]{36}$/.test(value.seekRouteToken)
                || !Number.isInteger(value.expiresInMs) || value.expiresInMs < 1 || value.expiresInMs > 5000)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.pausedProofTransferId = null;
              if (value.pausedProofTransferId != null) {
                if (capabilities.boundedPausedProofTransfer !== true || !/^[a-f0-9-]{36}$/.test(value.pausedProofTransferId)
                  || typeof sourceObservation?.acceptTransfer !== 'function') throw failure('ROUTE_PROTOCOL_INVALID');
                if (sourceObservation.acceptTransfer(value.pausedProofTransferId)) record.pausedProofTransferId = value.pausedProofTransferId;
              }
              record.intervalId = null; record.seekParked = true; record.suspended = false;
              record.seekRouteToken = value.seekRouteToken; record.seekTransaction = seekTransaction;
              record.preparationStage = 'seek-parked';
            }); },
            suspendPaused({ sourceObservation } = {}) { return serialize(async () => {
              own(record);
              if (record.suspended) return;
              if (record.seekTransaction) {
                if (!record.safeToRestore || record.captureStage !== 'stopped' || !record.publicationClosed)
                  throw failure('ROUTE_PROOF_UNCONFIRMED');
                const value = await host.request('seekCancelToPaused', { ...payload(record),
                  seekTransaction: record.seekTransaction, intervalEpoch: record.intervalEpoch });
                own(record); requireLease(value, record, 'pausedHeld');
                if (value.state !== 'pausedHeld' || value.ready !== false || value.pausedHeld !== true
                  || value.intervalArmed !== false || value.intervalId != null || value.intervalEpoch !== record.intervalEpoch)
                  throw failure('ROUTE_PROOF_UNCONFIRMED');
                record.intervalId = null; record.suspended = true; record.seekParked = false;
                record.seekTransaction = null; record.seekRouteToken = null; record.captureParkReceipt = null;
                record.pausedProofTransferId = null; record.preparationStage = 'suspended'; return;
              }
              if (!record.safeToRestore || record.captureStage !== 'stopped' || !record.publicationClosed
                || record.preparationStage !== 'completed') throw failure('ROUTE_PROOF_UNCONFIRMED');
              const capabilities = sourceObservation && await host.capabilities?.(); own(record);
              const reusePauseObservation = capabilities?.boundedPausedHoldObservation === true && sourceObservation?.isCurrent() === true;
              const value = await host.request('suspendPaused', { ...payload(record), intervalEpoch: record.intervalEpoch,
                ...(reusePauseObservation ? { reusePauseObservation: true } : {}) });
              own(record); requireLease(value, record, 'pausedHeld');
              if (value.state !== 'pausedHeld' || value.code !== 'PAUSED_ROUTE_HELD' || value.ready !== false
                || value.pausedHeld !== true || value.intervalArmed !== false || value.intervalId != null
                || value.intervalEpoch !== record.intervalEpoch || value.resumeAuthorized === true)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.pausedProofTransferId = null;
              if (value.pausedProofTransferId != null) {
                if (capabilities?.boundedPausedProofTransfer !== true || !/^[a-f0-9-]{36}$/.test(value.pausedProofTransferId)
                  || typeof sourceObservation?.acceptTransfer !== 'function') throw failure('ROUTE_PROTOCOL_INVALID');
                if (sourceObservation.acceptTransfer(value.pausedProofTransferId)) record.pausedProofTransferId = value.pausedProofTransferId;
              }
              record.intervalId = null; record.suspended = true; record.preparationStage = 'suspended';
              diagnostic('paused-held', record);
            }); },
            holdExternalSelection(selectedTrackId) { return serialize(async () => {
              own(record);
              if (!record.safeToRestore || record.captureStage !== 'stopped' || !record.publicationClosed
                || record.seekParked || !['completed','suspended'].includes(record.preparationStage)
                || !/^[A-Za-z0-9]{22}$/.test(selectedTrackId || '')) throw failure('ROUTE_PROOF_UNCONFIRMED');
              const selected=`spotify:track:${selectedTrackId}`, next=record.sourceEpoch+1;
              if(selected===record.selectedSourceUri || !Number.isSafeInteger(next))throw failure('ROUTE_PROTOCOL_INVALID');
              try {
                const value=await host.request('holdExternalSelection',{...payload(record),intervalEpoch:record.intervalEpoch,
                  sourceEpoch:next,pausedSourceUri:record.selectedSourceUri,selectedSourceUri:selected});
                own(record);requireLease(value,record,'pausedHeld');
                if(value.state!=='pausedHeld'||value.code!=='PAUSED_ROUTE_HELD'||value.ready!==false
                  ||value.pausedHeld!==true||value.intervalArmed!==false||value.intervalId!=null
                  ||value.resumeAuthorized===true||value.intervalEpoch!==record.intervalEpoch
                  ||value.lease.sourceEpoch!==next||value.lease.expectedSourceUri!==selected)throw failure('ROUTE_PROOF_UNCONFIRMED');
                record.sourceEpoch=next;record.selectedSourceUri=selected;record.intervalId=null;
                record.suspended=true;record.preparationStage='suspended';record.pausedProofTransferId=null;
                diagnostic('external-track-held',record);
              } catch(error){record.rebindFailed=true;throw error;}
            }); },
            rebindPreparedSelection({ selectedTrackId, pausedTrackId } = {}) { return serialize(async () => {
              own(record);
              if (!record.suspended || record.seekParked || !record.safeToRestore || record.captureStage !== 'stopped'
                || !record.publicationClosed || record.intervalId || record.preparationStage !== 'suspended'
                || typeof selectedTrackId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(selectedTrackId)
                || typeof pausedTrackId !== 'string' || `spotify:track:${pausedTrackId}` !== record.selectedSourceUri)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              const nextEpoch = record.intervalEpoch + 1;
              if (!Number.isSafeInteger(nextEpoch)) throw failure('ROUTE_PROTOCOL_INVALID');
              const selected = `spotify:track:${selectedTrackId}`, nextSourceEpoch = record.sourceEpoch + 1;
              if (!Number.isSafeInteger(nextSourceEpoch)) throw failure('ROUTE_PROTOCOL_INVALID');
              // One explicit handoff consumes the old track's proof. Neither a
              // failed ACK nor an old closure may publish for the next track.
              record.pausedProofTransferId = null;
              try {
                const value = await host.request('rebindPreparedSelection', { ...payload(record),
                  pausedSourceUri: record.selectedSourceUri, selectedSourceUri: selected, intervalEpoch: nextEpoch, sourceEpoch: nextSourceEpoch });
                own(record); requireLease(value, record, 'preparedSelection');
                if (value.state !== 'preparedSelection' || value.code !== 'TRACK_PREPARATION_AUTHORIZED'
                  || value.preparedSelectionAuthorized !== true || value.preparedTargetActive !== false
                  || value.ready !== false || value.resumeAuthorized === true || value.intervalArmed !== false
                  || value.intervalId != null || value.intervalEpoch !== nextEpoch || value.lease.sourceEpoch !== nextSourceEpoch)
                  throw failure('ROUTE_PROOF_UNCONFIRMED');
                record.selectedSourceUri = selected; record.intervalEpoch = nextEpoch; record.sourceEpoch = nextSourceEpoch;
                record.suspended = false; record.captureStage = 'not-requested';
                record.preparationStage = 'authorized'; record.safeToRestore = false;
                diagnostic('track-preparing', record);
              } catch (error) { record.rebindFailed = true; throw error; }
            }); },
            resumePreparation({ selectedTrackId, pausedProofTransferId, resumeIntentId } = {}) { return serialize(async () => {
              own(record);
              const seek = record.seekParked === true;
              if ((!record.suspended && !seek) || !record.safeToRestore || record.captureStage !== (seek ? 'seek-parked' : 'stopped') || !record.publicationClosed
                || typeof selectedTrackId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(selectedTrackId)
                || `spotify:track:${selectedTrackId}` !== record.selectedSourceUri)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              const nextEpoch = record.intervalEpoch + 1;
              if (!Number.isSafeInteger(nextEpoch)) throw failure('ROUTE_PROTOCOL_INVALID');
              if (pausedProofTransferId != null && (pausedProofTransferId !== record.pausedProofTransferId
                || typeof resumeIntentId !== 'string' || !/^[a-f0-9-]{36}$/.test(resumeIntentId))) throw failure('ROUTE_PROTOCOL_INVALID');
              record.pausedProofTransferId = null;
              const value = await host.request(seek ? 'seekResumePreparation' : 'resumePreparation', { ...payload(record),
                ...(seek ? { seekTransaction: record.seekTransaction, seekRouteToken: record.seekRouteToken } : {}),
                selectedSourceUri: record.selectedSourceUri, intervalEpoch: nextEpoch,
                ...(pausedProofTransferId ? { pausedProofTransferId, resumeIntentId } : {}) });
              own(record); requireLease(value, record, 'preparedSelection');
              if (value.state !== 'preparedSelection' || value.code !== 'RESUME_PREPARATION_AUTHORIZED'
                || value.preparedSelectionAuthorized !== true || value.preparedTargetActive !== true || value.ready !== false || value.resumeAuthorized === true
                || value.intervalArmed !== false || value.intervalId != null || value.intervalEpoch !== nextEpoch)
                throw failure('ROUTE_PROOF_UNCONFIRMED');
              record.intervalEpoch = nextEpoch; record.suspended = false; record.seekParked = false; record.seekRouteToken = null;
              record.captureStage = seek ? 'seek-parked' : 'not-requested';
              record.preparationStage = 'target-observed'; record.safeToRestore = false;
              diagnostic('resume-preparing', record);
            }); },
            confirmPaused() { if (current === record && !record.released) record.safeToRestore = true; },
            release() { return serialize(() => restore(record)); },
          });
        } catch (error) {
          if (error?.noPolicyWrites === true && error.code === 'NO_POLICY_WRITES' && !record.leaseId) {
            host.confirmReleased?.({ session: record.session, generation: record.generation });
            record.released = true; if (current === record) current = null;
            throw Object.assign(failure(error.failureCode), { noPolicyWrites: true });
          }
          if (error?.restoreReceipt && !record.leaseId) {
            try {
              const value = error.restoreReceipt, lease = requireLease(value, record, 'restored');
              if (value.state !== 'restored' || value.exactOriginalRolesRestored !== true || value.globalDefaultsWritten !== false
                || typeof value.observedDefaultsChanged !== 'boolean')
                throw failure('ROUTE_RESTORE_UNCONFIRMED');
              // The failed acquisition must restore the exact independently observed nullable raw values.
              host.confirmReleased?.({ session: record.session, generation: record.generation });
              record.released = true; if (current === record) current = null;
              diagnostic('restored', record, undefined, value);
            } catch { blocked = failure('ROUTE_RESTORE_UNCONFIRMED'); throw blocked; }
            throw failure(error.failureCode || error.restoreReceipt?.failureCode);
          }
          if (!record.released) {
            // A cancelled acquire may already have attempted its one compensation.
            // Retain its receipt for a later request instead of retrying in this catch.
            if (record.restoreFailed) throw blocked || failure('ROUTE_RESTORE_UNCONFIRMED');
            if (record.leaseId) await restore(record);
            else { blocked = failure('ROUTE_RESTORE_UNCONFIRMED'); notify(record, blocked); throw blocked; }
          }
          throw error;
        }
      });
    },
    releaseRetained() {
      return serialize(async () => {
        if (current) {
          if (!current.publicationClosed || !['not-requested', 'prepared', 'stopped'].includes(current.captureStage))
            throw failure('ROUTE_SOURCE_PAUSE_UNCONFIRMED');
          await restore(current);
        }
        if (current || blocked) throw blocked || failure('ROUTE_RESTORE_UNCONFIRMED');
        return { released: true };
      });
    },
    releaseBeforeClose() {
      return serialize(async () => {
        if (!current) return;
        // A failed acquire may retain a route before audio receives its lease.
        // Retire that owner before permanently closing a reusable capture host.
        if (current.publicationClosed === true && ['not-requested', 'prepared', 'stopped'].includes(current.captureStage))
          await restore(current);
      });
    },
    close() {
      if (closing) return closing;
      closing = serialize(async () => {
        closed = true;
        let error;
        try { await restore(current); } catch (caught) { error = caught; }
        // Keep the exact proof broker available when native has retained a pre-write owner.
        if (isRetryableRouteCleanup(error)) {
          // Quit was refused before restoration writes. The live application
          // still owns this lease and must keep its explicit retry path alive.
          closed = false;
          if (current) heartbeat(current);
          throw error;
        }
        let terminal;
        try { terminal = await host.close(); } catch (caught) { error ||= caught; }
        if ((error || blocked) && current && terminal?.helperExitConfirmed === true) {
          try {
            requireLease(terminal, current, 'restored');
            if (terminal.state !== 'closed' || terminal.exactOriginalRolesRestored !== true
              || terminal.globalDefaultsWritten !== false || typeof terminal.observedDefaultsChanged !== 'boolean')
              throw failure('ROUTE_RESTORE_UNCONFIRMED');
            // Only the exact terminal lease and confirmed clean helper exit can
            // supersede an earlier cleanup error. Unknown state is never cleared.
            host.confirmReleased?.({ session: current.session, generation: current.generation });
            current.released = true;
            diagnostic('restored', current, undefined, terminal);
            current = null; blocked = null; error = null;
          } catch { /* Keep the original ownership barrier. */ }
        }
        if (error || blocked) throw error || blocked;
      });
      void closing.catch(error => { if (isRetryableRouteCleanup(error)) closing = null; });
      return closing;
    },
  };
}
module.exports = { createOwnedRouteLifecycle };
