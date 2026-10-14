'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { failure, qualified, CODES, physicalOwnerDiagnostic, operationFailureDiagnostic } = require('./ownedRouteProtocol.cjs');
const { VALIDATION_PROFILE, COMPATIBILITY_PROFILE, runtimeArtifact, trialArtifact } = require('./ownedRouteTrial.cjs');
const { publishPreviewDiagnostic } = require('../debug/privatePreviewDiagnosticBus.cjs');

// electron/spotify/ownedRouteHost.cjs: one private, long-lived child; no CLI roundtrip or executable search fallback.
async function resolveOwnedRouteComponent(directory, io = fs, { allowTrial = false } = {}) {
  try {
    const manifest = JSON.parse(await io.readFile(path.join(directory, 'component.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.protocolMajor !== 1 || manifest.executable !== 'folia-route-service.exe'
      || manifest.version !== '0.19.0-dev.28' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw failure('ROUTE_COMPONENT_INVALID');
    if (manifest.productionQualified !== true && !runtimeArtifact(manifest)) {
      if (!trialArtifact(manifest)) throw failure('ROUTE_HELPER_UNQUALIFIED');
      if (!allowTrial) throw Object.assign(failure('ROUTE_TRIAL_OPT_IN_REQUIRED'), { trialAvailable: true, validationProfile: VALIDATION_PROFILE });
    }
    // EXE-only hashing cannot qualify an apphost that loads adjacent managed DLLs.
    if (manifest.distribution !== 'self-contained-single-file') throw failure('ROUTE_COMPONENT_INVALID');
    const executable = path.join(directory, manifest.executable), stat = await io.lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024 * 1024
      || manifest.lengthBytes !== stat.size) throw failure('ROUTE_COMPONENT_INVALID');
    const bytes = await io.readFile(executable);
    if (bytes.length !== manifest.lengthBytes) throw failure('ROUTE_COMPONENT_INVALID');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== manifest.sha256) throw failure('ROUTE_COMPONENT_INVALID');
    return executable;
  } catch (error) {
    const safe = failure(error?.code === 'ENOENT' ? 'ROUTE_HELPER_UNAVAILABLE' : error?.code || 'ROUTE_COMPONENT_INVALID');
    if (error?.trialAvailable === true) Object.assign(safe, { trialAvailable: true, validationProfile: VALIDATION_PROFILE });
    throw safe;
  }
}
function createOwnedRouteHost({ componentDirectory, platform = process.platform, spawnImpl = spawn,
  resolveComponent = resolveOwnedRouteComponent, onSourceControl, onConfigurationRequired, timeoutMs, exitTimeoutMs = 5000,
  arch = process.arch, systemRelease = () => os.release(), processCapture = false } = {}) {
  let processRecord, starting, sequence = 0, closed = false, closing, requests = Promise.resolve(), trialEnabled = false;
  function broken(record, code) {
    if (record.dead) return;
    record.dead = true;
    record.sourceActive?.controller.abort();
    for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code)); }
    record.pending.clear();
    // EOF requests the helper's retained-journal compensation. Never treat kill as proof of restoration.
    try { record.child.stdin.end(); } catch {}
  }
  function receive(record, bytes) {
    if (record.dead) return;
    if (!(bytes instanceof Uint8Array) || record.buffer.length + bytes.length > 262144) return broken(record, 'ROUTE_PROTOCOL_INVALID');
    record.buffer = Buffer.concat([record.buffer, bytes]);
    for (;;) {
      const end = record.buffer.indexOf(10); if (end < 0) return;
      let value; try { value = JSON.parse(record.buffer.subarray(0, end).toString('utf8')); }
      catch { return broken(record, 'ROUTE_PROTOCOL_INVALID'); }
      record.buffer = record.buffer.subarray(end + 1);
      if (value?.event === 'sourceControl') { sourceControl(record, value); continue; }
      const pending = record.pending.get(value?.id);
      if (!pending || typeof value.ok !== 'boolean' || record.sourceActive?.command === pending)
        return broken(record, 'ROUTE_PROTOCOL_INVALID');
      record.pending.delete(value.id); clearTimeout(pending.timer);
      if (['suspendPaused', 'seekPark'].includes(pending.command) && record.routeScope) record.routeScope.preparationPhase = null;
      if (['rebindPreparedSelection', 'holdExternalSelection'].includes(pending.command) && record.routeScope?.pendingRebind) {
        const scope = record.routeScope, handoff = scope.pendingRebind;
        if (value.ok) { scope.sourceEpoch = handoff.sourceEpoch; scope.sourceIds = handoff.sourceIds;
          if(pending.command==='holdExternalSelection'){scope.baselineUri=scope.selectedUri;scope.preparationPhase=null;} }
        else { scope.baselineUri = handoff.baselineUri; scope.selectedUri = handoff.selectedUri; scope.preparationPhase = null; }
        scope.pendingRebind = null;
      }
      if (value.ok && pending.command === 'completePreparedSelection' && record.routeScope)
        record.routeScope.baselineUri = record.routeScope.selectedUri;
      if (value.ok) pending.resolve(value);
      else {
        const error = failure(value.code);
        if (/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code || '')) error.nativeCode = value.code;
        error.stage = 'route-' + pending.command;
        if (value.code === 'BASE_OR_UNPROVEN_DEFAULT_FEEDBACK_GUARD') {
          // Resume can discover an output change after the initial setup check.
          // Notify the existing guide without changing rejection or route ownership.
          try { onConfigurationRequired?.('NON_BASE_DEFAULT_OUTPUT_REQUIRED'); } catch {}
        }
        // Preserve bounded native error identifiers when the public projection
        // falls back, so a real handoff failure can be diagnosed without guessing.
        if (typeof value.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(value.code))
          publishPreviewDiagnostic('spotify.route-native-failure', { operation: pending.command,
            nativeCode: value.code, ...(typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(value.failureCode)
              ? { nativeFailureCode: value.failureCode } : {}) });
        if (CODES.has(value.failureCode)) error.failureCode = value.failureCode;
        const cause = error.failureCode || error.code;
        if (pending.command === 'inspect') {
          const diagnostic = operationFailureDiagnostic(value.operationFailureDiagnostic);
          if (diagnostic) publishPreviewDiagnostic('spotify.route-operation-failure', {
            operation: pending.command, errorCode: cause, ...diagnostic,
          });
        }
        if (['ORIGINAL_PHYSICAL_OWNER_UNPROVEN', 'ORIGINAL_EXPLICIT_ENDPOINT_CHANGED'].includes(cause)) {
          const diagnostic = physicalOwnerDiagnostic(value.physicalOwnerDiagnostic);
          if (diagnostic) publishPreviewDiagnostic('spotify.route-owner-proof', {
            operation: pending.command, errorCode: cause, ...diagnostic,
          });
        }
        if (value.state === 'closed' && value.code === 'NO_POLICY_WRITES' && value.noPolicyWrites === true) error.noPolicyWrites = true;
        if (pending.command === 'release' && value.cleanupRetryable === true && value.restoreWritesStarted === false
          && value.state === 'recoveryRequired') error.retryableCleanupReceipt = value;
        if (value.state === 'restored' && value.exactOriginalRolesRestored === true
          && value.globalDefaultsWritten === false && typeof value.observedDefaultsChanged === 'boolean') error.restoreReceipt = value;
        pending.reject(error);
      }
    }
  }
  // Only our live child may ask for an exact held-source read/pause while a routing command awaits proof.
  function sourceControl(record, input) {
    const restoreRequest = [...record.pending.values()].find(value => value.command === 'release');
    const pausedHoldRequest = [...record.pending.values()].find(value => ['suspendPaused', 'seekPark'].includes(value.command) && value.reusePauseObservation);
    const resumeRequest = [...record.pending.values()].find(value => ['resumePreparation', 'seekResumePreparation'].includes(value.command) && value.pausedProofTransferId);
    const scope = record.routeScope, keys = ['event', 'requestId', 'action', 'session', 'generation', 'sourceDeviceId',
      'sourceEpoch', 'expectedSourceUri', 'pausedPreviousUri', 'allowPreviousPaused', 'requirePreparedSelection', 'preparationSelectedSourceUri', 'requirePreparationObservation', 'preparationPhase', 'restoreOperationId', 'allowChangedTrackPausedForRestore', 'allowEmptyPlayerForRestore', 'pausedProofTransferId', 'resumeIntentId', 'pausedProofTransferFallback', 'requireSeekParkEvidence', 'seekTransaction', 'seekToken'];
    const sourceIds = scope?.pendingRebind?.sourceIds ?? scope?.sourceIds;
    const seekPark = input.requireSeekParkEvidence === true;
    const seekRequest = [...record.pending.values()].find(value => ['seekPark', 'seekResumePreparation', 'completePreparedSelection'].includes(value.command));
    if (input.requireSeekParkEvidence != null && typeof input.requireSeekParkEvidence !== 'boolean'
      || seekPark && (!seekRequest || record.capabilities?.boundedSeekPark !== true || input.action !== 'read'
        || input.seekTransaction !== scope?.seekTransaction || input.seekToken !== scope?.seekToken
        || input.restoreOperationId != null || input.allowPreviousPaused === true)
      || !seekPark && (input.seekTransaction != null || input.seekToken != null)) { broken(record, 'ROUTE_PROTOCOL_INVALID'); return; }
    const transfer = input.pausedProofTransferId != null, transferFallback = input.pausedProofTransferFallback === true;
    if (transfer || transferFallback) {
      if (!resumeRequest || input.action !== 'read' || input.requirePreparationObservation !== true
        || input.requirePreparedSelection !== true || input.restoreOperationId != null || input.allowPreviousPaused === true
        || transfer && (transferFallback || input.pausedProofTransferId !== resumeRequest.pausedProofTransferId
          || input.resumeIntentId !== resumeRequest.resumeIntentId || input.preparationPhase !== 'selected')
        || transferFallback && (input.resumeIntentId != null || input.preparationPhase !== 'baseline')) {
        broken(record, 'ROUTE_PROTOCOL_INVALID'); return;
      }
      if (transferFallback && scope) scope.preparationPhase = 'baseline';
    } else if (input.resumeIntentId != null) { broken(record, 'ROUTE_PROTOCOL_INVALID'); return; }
    const validUri = value => value === null || typeof value === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(value);
    if (!scope || record.sourceActive || typeof onSourceControl !== 'function'
      || Object.keys(input).some(key => !keys.includes(key))
      || !/^source-[a-f0-9-]{32,36}$/i.test(input.requestId || '') || sourceIds.has(input.requestId) || sourceIds.size >= 8192
      || !['read', 'pause'].includes(input.action) || input.session !== scope.session || input.generation !== scope.generation
      || input.sourceDeviceId !== scope.sourceDeviceId || input.sourceEpoch !== (scope.pendingRebind?.sourceEpoch ?? scope.sourceEpoch)
      || !validUri(input.expectedSourceUri)
      || ![scope.baselineUri, scope.selectedUri].includes(input.expectedSourceUri)
      || input.action === 'pause' && input.expectedSourceUri === null
      || input.allowPreviousPaused != null && typeof input.allowPreviousPaused !== 'boolean'
      || input.allowPreviousPaused === true && input.pausedPreviousUri !== scope.baselineUri
      || input.allowPreviousPaused !== true && input.pausedPreviousUri != null
      || input.allowChangedTrackPausedForRestore != null && typeof input.allowChangedTrackPausedForRestore !== 'boolean'
      || input.allowEmptyPlayerForRestore != null && typeof input.allowEmptyPlayerForRestore !== 'boolean'
      || input.allowEmptyPlayerForRestore === true && (input.action !== 'read' || input.restoreOperationId == null
        || input.requirePreparationObservation === true || input.requirePreparedSelection === true)
      || input.allowChangedTrackPausedForRestore === true && (input.action !== 'read' || input.restoreOperationId == null
        || input.requirePreparationObservation === true || input.requirePreparedSelection === true)
      || input.restoreOperationId != null && (input.action !== 'read' || !restoreRequest
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.restoreOperationId)
        || input.requirePreparationObservation === true || input.requirePreparedSelection === true || input.preparationPhase != null
        || scope.restoreOperationId != null && scope.restoreOperationId !== input.restoreOperationId)
      || input.requirePreparationObservation != null && typeof input.requirePreparationObservation !== 'boolean'
      || input.requirePreparationObservation === true && (input.action !== 'read' || !['baseline', 'selected'].includes(input.preparationPhase)
        || input.preparationPhase !== scope.preparationPhase)
      || input.requirePreparationObservation !== true && input.preparationPhase != null
      || input.requirePreparedSelection != null && typeof input.requirePreparedSelection !== 'boolean'
      || input.requirePreparedSelection === true && (input.action !== 'read' || input.preparationSelectedSourceUri !== scope.selectedUri
        || !validUri(input.preparationSelectedSourceUri) || input.preparationSelectedSourceUri === null)
      || input.requirePreparedSelection !== true && input.preparationSelectedSourceUri != null) {
      broken(record, 'ROUTE_PROTOCOL_INVALID'); return;
    }
    if (pausedHoldRequest && (input.action !== 'read'
      || input.requirePreparationObservation === true && input.preparationPhase !== 'selected'
      || input.requirePreparedSelection === true || input.restoreOperationId != null
      || input.allowPreviousPaused === true)) { broken(record, 'ROUTE_PROTOCOL_INVALID'); return; }
    sourceIds.add(input.requestId);
    if (input.restoreOperationId != null) scope.restoreOperationId = input.restoreOperationId;
    const sourceCommand = [...record.pending.values()][0];
    if (!sourceCommand) { broken(record, 'ROUTE_PROTOCOL_INVALID'); return; }
    const controller = new AbortController(), active = { controller, command: sourceCommand }; record.sourceActive = active;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(failure('ROUTE_CONTROL_TIMEOUT'));
    }, input.action === 'read' ? 4500 : 10500); });
    const perform = Promise.resolve().then(() => onSourceControl({ action: input.action, session: input.session,
      generation: input.generation, sourceDeviceId: input.sourceDeviceId, expectedSourceUri: input.expectedSourceUri,
      pausedPreviousUri: input.pausedPreviousUri ?? null, allowPreviousPaused: input.allowPreviousPaused === true,
      ...(input.requirePreparedSelection === true ? { requirePreparedSelection: true, preparationSelectedSourceUri: input.preparationSelectedSourceUri } : {}),
      ...(input.requirePreparationObservation === true ? { requirePreparationObservation: true, preparationPhase: input.preparationPhase } : {}),
      ...(seekPark ? { requireSeekParkEvidence: true, seekTransaction: input.seekTransaction, seekToken: input.seekToken } : {}),
      ...(transfer ? { pausedProofTransferId: input.pausedProofTransferId, resumeIntentId: input.resumeIntentId } : {}),
      ...(transferFallback ? { pausedProofTransferFallback: true } : {}),
      ...(pausedHoldRequest ? input.requirePreparationObservation === true
        ? { pauseObservationOnly: true } : { pauseFreshFallback: true } : {}),
      ...(input.restoreOperationId != null ? { restoreOperationId: input.restoreOperationId,
        ...(input.allowChangedTrackPausedForRestore === true ? { allowChangedTrackPausedForRestore: true } : {}),
        ...(input.allowEmptyPlayerForRestore === true ? { allowEmptyPlayerForRestore: true } : {}) } : {}) }, { signal: controller.signal }));
    void Promise.race([perform, timeout]).then(value => {
      const emptyRestore = value?.emptyPlayer === true;
      const parkProof = seekPark ? require('./captureSeekReceipt.cjs').captureSeekReceipt(value?.captureParkReceipt,
        { session: scope.session, seekTransaction: input.seekTransaction }) : null;
      if (seekPark && parkProof.seekToken !== input.seekToken || !seekPark && value?.captureParkReceipt != null)
        throw failure('ROUTE_PROTOCOL_INVALID');
      if (value?.pausedProofTransferSuperseded != null && (!transfer || typeof value.pausedProofTransferSuperseded !== 'boolean'))
        throw failure('ROUTE_PROTOCOL_INVALID');
      if (value?.emptyPlayer != null && typeof value.emptyPlayer !== 'boolean'
        || emptyRestore && (input.allowEmptyPlayerForRestore !== true || input.restoreOperationId == null
          || input.action !== 'read' || value.trackUri !== null || value.isPlaying !== null || value.positionMs !== null))
        throw failure('ROUTE_PROTOCOL_INVALID');
      if (!value || value.sourceDeviceId !== scope.sourceDeviceId || !validUri(value.trackUri)
        || !emptyRestore && typeof value.isPlaying !== 'boolean' || typeof value.observedAtUtc !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAtUtc)) throw failure('ROUTE_PROTOCOL_INVALID');
      if ((input.requirePreparedSelection === true || input.requirePreparationObservation === true) && (value.preparationOwned !== true
        || value.playbackRequestPending !== false || input.requirePreparedSelection === true && (seekPark ? !parkProof : value.pcmStopped !== true))) throw failure('ROUTE_PROOF_UNCONFIRMED');
      const observationFields = ['observationGeneration', 'mutationEpoch', 'preparationPhase', 'positionMs', 'restoreOperationId'];
      if (input.requirePreparationObservation === true || input.restoreOperationId != null) {
        if (!Number.isSafeInteger(value.observationGeneration) || value.observationGeneration < 1
          || !Number.isSafeInteger(value.mutationEpoch) || value.mutationEpoch < 0
          || (emptyRestore ? value.positionMs !== null : !Number.isSafeInteger(value.positionMs) || value.positionMs < 0)
          || (input.requirePreparationObservation === true ? value.preparationPhase !== input.preparationPhase || value.restoreOperationId != null
            : value.restoreOperationId !== input.restoreOperationId || value.preparationPhase != null
              || value.pcmStopped !== true || value.playbackRequestPending !== false)) throw failure('ROUTE_PROOF_UNCONFIRMED');
      } else if (observationFields.some(key => value[key] != null)) throw failure('PREPARATION_OBSERVATION_FORBIDDEN');
      return { ok: true, sourceDeviceId: value.sourceDeviceId, trackUri: value.trackUri,
        isPlaying: value.isPlaying, observedAtUtc: value.observedAtUtc, pcmStopped: value.pcmStopped === true,
        ...(seekPark ? { captureParkReceipt: parkProof } : {}),
        ...(emptyRestore ? { emptyPlayer: true } : {}),
        ...(transfer && value.pausedProofTransferSuperseded === true ? { pausedProofTransferSuperseded: true } : {}),
        ...((input.requirePreparedSelection === true || input.requirePreparationObservation === true) ? { preparationOwned: true, playbackRequestPending: false } : {}),
        ...(input.requirePreparationObservation === true ? { observationGeneration: value.observationGeneration,
          mutationEpoch: value.mutationEpoch, preparationPhase: value.preparationPhase, positionMs: value.positionMs } : {}),
        ...(input.restoreOperationId != null ? { restoreOperationId: value.restoreOperationId, observationGeneration: value.observationGeneration,
          mutationEpoch: value.mutationEpoch, positionMs: value.positionMs, playbackRequestPending: false } : {}) };
    }).catch(() => ({ ok: false, code: 'SOURCE_CONTROL_UNCONFIRMED' })).then(payload => {
      clearTimeout(timer); if (record.sourceActive === active) record.sourceActive = null;
      if (record.dead || record.exited || record.routeScope !== scope) return;
      if (![...record.pending.values()].includes(sourceCommand)) return broken(record, 'ROUTE_PROTOCOL_INVALID');
      if (input.restoreOperationId != null && ![...record.pending.values()].includes(restoreRequest)) return broken(record, 'ROUTE_PROTOCOL_INVALID');
      if (pausedHoldRequest && ![...record.pending.values()].includes(pausedHoldRequest)) return broken(record, 'ROUTE_PROTOCOL_INVALID');
      const line = JSON.stringify({ id: input.requestId, command: 'sourceControlResult', payload }) + '\n';
      try { record.child.stdin.write(line, error => { if (error) broken(record, 'ROUTE_HELPER_CLOSED'); }); }
      catch { broken(record, 'ROUTE_HELPER_CLOSED'); }
    }).catch(() => broken(record, 'ROUTE_PROTOCOL_INVALID'));
  }
  function send(record, command, payload = {}) {
    if (record.dead || record.exited) return Promise.reject(failure('ROUTE_HELPER_CLOSED'));
    if (['suspendPaused', 'seekPark'].includes(command) && payload.reusePauseObservation != null
      && (typeof payload.reusePauseObservation !== 'boolean'
        || payload.reusePauseObservation === true && record.capabilities?.boundedPausedHoldObservation !== true))
      return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    if (['resumePreparation', 'seekResumePreparation'].includes(command) && payload.pausedProofTransferId != null
      && (record.capabilities?.boundedPausedProofTransfer !== true || !/^[a-f0-9-]{36}$/.test(payload.pausedProofTransferId)
        || !/^[a-f0-9-]{36}$/.test(payload.resumeIntentId || ''))) return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    if (['rebindPreparedSelection', 'validateHeld'].includes(command) && record.capabilities?.providerRouteLifetime !== true)
      return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    if (record.pending.size >= 8) return Promise.reject(failure('ROUTE_BUSY'));
    const id = String(++sequence), line = JSON.stringify({ id, command, payload }) + '\n';
    if (['seekPark', 'seekResumePreparation', 'seekCancelToPaused'].includes(command)
      && record.capabilities?.boundedSeekPark !== true) return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    if (command === 'seekPark' && record.routeScope) {
      record.routeScope.seekTransaction = payload.seekTransaction;
      record.routeScope.seekToken = payload.captureParkReceipt?.seekToken;
    }
    if (['seekCancelToPaused', 'release', 'close'].includes(command) && record.routeScope) {
      record.routeScope.seekTransaction = null; record.routeScope.seekToken = null; record.routeScope.preparationPhase = null;
    }
    if (command === 'release' && record.routeScope) record.routeScope.restoreOperationId = null;
    if (command === 'acquire') {
      record.acquireSent = true;
      record.routeScope = { session: payload.session, generation: payload.generation, sourceDeviceId: payload.sourceDeviceId,
        baselineUri: payload.expectedSourceUri, selectedUri: undefined, sourceEpoch: 1, preparationPhase: 'baseline', sourceIds: new Set() };
    }
    if (command === 'holdExternalSelection' && record.capabilities?.externalTrackHold !== true)
      return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    if (['rebindPreparedSelection', 'holdExternalSelection'].includes(command)) {
      const scope = record.routeScope;
      if (!scope || record.sourceActive || scope.selectedUri !== payload.pausedSourceUri
        || !/^spotify:track:[A-Za-z0-9]{22}$/.test(payload.selectedSourceUri || '')
        || !Number.isSafeInteger(payload.sourceEpoch) || payload.sourceEpoch !== scope.sourceEpoch + 1
        || payload.pausedProofTransferId != null || payload.resumeIntentId != null)
        return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
      scope.pendingRebind = { sourceEpoch: payload.sourceEpoch, baselineUri: scope.baselineUri, selectedUri: scope.selectedUri, sourceIds: new Set() };
      scope.baselineUri = scope.selectedUri;
      scope.selectedUri = payload.selectedSourceUri; scope.preparationPhase = command==='holdExternalSelection'?null:'baseline';
    }
    if (['resumePreparation', 'seekResumePreparation'].includes(command) && record.routeScope) {
      record.routeScope.baselineUri = record.routeScope.selectedUri; record.routeScope.preparationPhase = payload.pausedProofTransferId ? 'selected' : 'baseline';
    }
    if (['suspendPaused', 'seekPark'].includes(command) && record.routeScope)
      record.routeScope.preparationPhase = payload.reusePauseObservation === true ? 'selected' : null;
    if (command === 'completePreparedSelection' && record.routeScope) record.routeScope.preparationPhase = 'selected';
    if (['release', 'close'].includes(command) && record.routeScope) record.routeScope.preparationPhase = null;
    if (['authorizePreparedSelection', 'authorizeResume'].includes(command) && record.routeScope) record.routeScope.selectedUri = payload.selectedSourceUri;
    if (Buffer.byteLength(line) > 16384) return Promise.reject(failure('ROUTE_PROTOCOL_INVALID'));
    return new Promise((resolve, reject) => {
      const budget = timeoutMs ?? (['acquire', 'release', 'close'].includes(command) ? 100000 : command === 'inspect' ? 20000 : ['authorizePreparedSelection', 'completePreparedSelection', 'suspendPaused', 'holdExternalSelection', 'resumePreparation', 'rebindPreparedSelection', 'seekPark', 'seekResumePreparation', 'seekCancelToPaused', 'armCaptureInterval', 'authorizeResume'].includes(command) ? 22000 : 15000);
      const timer = setTimeout(() => broken(record, 'ROUTE_CONTROL_TIMEOUT'), budget);
      record.pending.set(id, { resolve, reject, timer, command,
        pausedProofTransferId: ['resumePreparation', 'seekResumePreparation'].includes(command) ? payload.pausedProofTransferId : undefined,
        resumeIntentId: ['resumePreparation', 'seekResumePreparation'].includes(command) ? payload.resumeIntentId : undefined,
        reusePauseObservation: ['suspendPaused', 'seekPark'].includes(command) && payload.reusePauseObservation === true });
      try { record.child.stdin.write(line, error => { if (error) broken(record, 'ROUTE_HELPER_CLOSED'); }); }
      catch { broken(record, 'ROUTE_HELPER_CLOSED'); }
    });
  }
  async function ensure() {
    if (closed) throw failure('ROUTE_HELPER_CLOSED');
    if (starting) return starting;
    starting = (async () => {
      if (platform !== 'win32') throw failure('ROUTE_HELPER_UNAVAILABLE');
      if (arch !== 'x64') throw failure('APP_ROUTE_X64_REQUIRED');
      const executable = await resolveComponent(componentDirectory, undefined, { allowTrial: trialEnabled });
      if (closed) throw failure('ROUTE_HELPER_CLOSED');
      let child;
      try { child = spawnImpl(executable, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FOLIA_SPOTIFY_PROCESS_CAPTURE: processCapture ? '1' : '0' } }); }
      catch { throw failure('ROUTE_HELPER_UNAVAILABLE'); }
      const record = { child, pending: new Map(), buffer: Buffer.alloc(0), dead: false, exited: false }; processRecord = record;
      child.on('exit', (code, signal) => {
        record.exited = true; record.exitCode = code; record.exitSignal = signal;
        record.finishExit?.(); broken(record, 'ROUTE_HELPER_CLOSED');
      });
      child.on('error', () => broken(record, 'ROUTE_HELPER_UNAVAILABLE'));
      child.stdin.on('error', () => broken(record, 'ROUTE_HELPER_CLOSED'));
      child.stdout.on('data', bytes => receive(record, bytes));
      child.stdout.on('error', () => broken(record, 'ROUTE_PROTOCOL_INVALID'));
      child.stdout.on('end', () => broken(record, 'ROUTE_HELPER_CLOSED'));
      child.stderr.on('data', () => {}); child.stderr.on('error', () => {});
      const hello = await send(record, 'hello', { protocolMajor: 1 });
      if (!qualified(hello.capabilities, { allowTrial: trialEnabled })) {
        const code = hello.capabilities?.blockers?.find(value => CODES.has(value)) || 'ROUTE_HELPER_UNQUALIFIED';
        broken(record, code); throw failure(code);
      }
      record.capabilities = { supported: true, productionQualified: hello.capabilities.productionQualified === true,
        externalTrackHold: hello.capabilities.operations.includes('holdExternalSelection'),
        boundedPausedHoldObservation: hello.capabilities.boundedPausedHoldObservation === true,
        boundedPausedProofTransfer: hello.capabilities.boundedPausedProofTransfer === true,
        boundedSeekPark: hello.capabilities.boundedSeekPark === true,
        providerRouteLifetime: hello.capabilities.providerRouteLifetime === true,
        ...(hello.capabilities.runtimeCompatible === true ? { runtimeCompatible: true, compatibilityProfile: COMPATIBILITY_PROFILE,
          windowsBuild: hello.capabilities.windowsBuild, routeInterfaceId: hello.capabilities.routeInterfaceId }
          : hello.capabilities.productionQualified !== true ? { trialAuthorized: true, validationProfile: VALIDATION_PROFILE } : {}) };
      return record;
    })();
    return starting;
  }
  return {
    async componentOffer() {
      // Passive settings only advertise the fixed artifact type. They never start a routing process.
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(componentDirectory, 'component.json'), 'utf8'));
        return { trialAvailable: trialArtifact(manifest), validationProfile: trialArtifact(manifest) ? VALIDATION_PROFILE : undefined };
      } catch { return { trialAvailable: false }; }
    },
    request(command, payload) {
      const task = requests.then(async () => {
        const record = await ensure();
        if (record.capabilities.trialAuthorized && !trialEnabled && !['release', 'close'].includes(command)) throw failure('ROUTE_TRIAL_OPT_IN_REQUIRED');
        return send(record, command, payload);
      });
      requests = task.catch(() => {}); return task;
    },
    async capabilities() {
      try {
        const record = await ensure();
        if (record.capabilities.trialAuthorized && !trialEnabled)
          throw Object.assign(failure('ROUTE_TRIAL_OPT_IN_REQUIRED'), { trialAvailable: true, validationProfile: VALIDATION_PROFILE });
        return { ...record.capabilities };
      } catch (error) { return { supported: false, productionQualified: false, code: failure(error?.code).code,
        ...(error?.trialAvailable === true ? { trialAvailable: true, validationProfile: VALIDATION_PROFILE } : {}) }; }
    },
    setTrialEnabled(value) {
      if (typeof value !== 'boolean') throw failure('ROUTE_PROTOCOL_INVALID');
      if (value === trialEnabled) return;
      if (processRecord?.routeScope) throw failure('ROUTE_BUSY');
      trialEnabled = value;
      if (!processRecord) starting = undefined;
    },
    confirmReleased({ session, generation }) {
      const record = processRecord;
      if (record?.routeScope?.session !== session || record.routeScope.generation !== generation) throw failure('ROUTE_PROTOCOL_INVALID');
      record.routeScope = null;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await starting?.catch(() => {});
        await requests;
        const record = processRecord; if (!record) return;
        let failed, terminal;
        if (!record.dead && !record.exited) {
          try { const result = await send(record, 'close'); terminal = result;
            const noWrites = result.code === 'NO_POLICY_WRITES' && (!record.acquireSent || result.noPolicyWrites === true);
            if (result.state !== 'closed' || !noWrites && (result.exactOriginalRolesRestored !== true
              || result.globalDefaultsWritten !== false || typeof result.observedDefaultsChanged !== 'boolean'))
              failed = failure('ROUTE_RESTORE_UNCONFIRMED');
          } catch { failed = failure('ROUTE_RESTORE_UNCONFIRMED'); }
        } else if (record.acquireSent) failed = failure('ROUTE_RESTORE_UNCONFIRMED');
        if (!record.exited) {
          try { record.child.stdin.end(); } catch {}
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(failure('ROUTE_HELPER_EXIT_UNCONFIRMED')), exitTimeoutMs);
            record.finishExit = () => { clearTimeout(timer); resolve(); };
            if (record.exited) record.finishExit();
          });
        }
        if (record.exitCode !== 0 || record.exitSignal != null) throw failure('ROUTE_HELPER_ABNORMAL_EXIT');
        if (failed) throw failed;
        return terminal ? { ...terminal, helperExitConfirmed: true } : undefined;
      })();
      return closing;
    },
  };
}
module.exports = { createOwnedRouteHost, resolveOwnedRouteComponent };



