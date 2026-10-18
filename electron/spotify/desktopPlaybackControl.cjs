'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { createHttpPlaybackSource } = require('./httpPlaybackSource.cjs');
const { createColdVolumeReceipt } = require('./desktopColdRecovery.cjs');
const { createDesktopPreparationIntent } = require('./desktopPreparationIntent.cjs');
const { retryPlayback } = require('./playbackRetry.cjs');
const { reportSpotifyPlaybackControl, reportSpotifyColdBootstrap } = require('./requestDiagnostics.cjs');
const { fail, failureCode, validDeviceId, validTrackId, validSessionId, sameStamp, position,
  normalizeDevices, requireDevice } = require('./desktopPlaybackFacts.cjs');

// electron/spotify/desktopPlaybackControl.cjs: one explicit desktop target, with observed command completion and revocable leases.
function createDesktopPlaybackControl({ onRevoke = () => {}, onFailureDiagnostic = () => {}, now = Date.now,
  wait = (ms, signal) => delay(ms, undefined, { signal }), settleTimeoutMs = 4000, settleIntervalMs = 400,
  selectionTimeoutMs = Math.min(settleTimeoutMs, 4000),
  readRoutePcmEvidence = () => false,
  readSeekParkEvidence = () => null,
  coldBootstrapDirectory, createSourceApi = createHttpPlaybackSource, reuseColdTrack = false,
  ...dependencies }) {
  if (typeof onRevoke !== 'function' || typeof wait !== 'function'
    || !Number.isInteger(selectionTimeoutMs) || selectionTimeoutMs < 1 || selectionTimeoutMs > 30000
    || !Number.isInteger(settleTimeoutMs) || settleTimeoutMs < 1 || settleTimeoutMs > 10000
    || !Number.isInteger(settleIntervalMs) || settleIntervalMs < 1 || settleIntervalMs > settleTimeoutMs) throw fail('PROTOCOL_INVALID');
  const api = createSourceApi({ ...dependencies, now });
  let current, revision = 0, closed = false, mutation = Promise.resolve(), mutationSettled = true, uncertainMutation = false;
  const routeSources = new Map();
  const observations = new Set(), devicePreparations = new WeakMap();
  let coldCleanup, observationGeneration = 0, mutationGeneration = 0, preparationDevices;
  const OBSERVATION_MAX_AGE_MS = 5000;
  const TRANSFER_MAX_AGE_MS = 500;
  // Only the selected source adapter creates state receipts. HTTP requires GET;
  // desktop requires a private ordered-source capability. Events never become GETs.
  // Reuse never refreshes its time,
  // mutation epoch or generation; each control dispatch invalidates first.
  function invalidateObservation(record) {
    // A retained native source owner spans track controllers; its proof floor never resets.
    record.mutationEpoch = ++mutationGeneration;
    record.sourceObservation = undefined;
    record.observationRead = undefined;
    record.pausedHoldObservation = undefined;
    record.pausedResumeTransfer = undefined;
    record.completedPause = undefined;
    record.pendingPositionStart = undefined;
    if (record.pausedHoldProof) record.pausedHoldProof.invalidated = true;
    if (record.restoreObservation) record.restoreObservation.invalidated = true;
  }
  function setPreparationPhase(record, phase) {
    if (record.preparationPhase !== phase) { invalidateObservation(record); record.preparationPhase = phase; }
  }
  function rememberObservation(record, body, epoch) {
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    let facts;
    try {
      const { trackId, durationMs } = api.describeState(body);
      if (!trackId || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      facts = api.playbackFacts(body, { ...record, trackId, durationMs }, { now });
    } catch { record.sourceObservation = undefined; return; }
    if (facts.serverTimestamp != null && record.observationTimestampFloor != null && facts.serverTimestamp < record.observationTimestampFloor) {
      record.sourceObservation = undefined; return;
    }
    if (facts.serverTimestamp != null) record.observationTimestampFloor = facts.serverTimestamp;
    facts = Object.freeze({ ...facts, disallows: Object.freeze({ ...facts.disallows }) });
    record.sourceObservation = { facts, mutationEpoch: epoch, observationGeneration: ++observationGeneration,
      preparationPhase: record.preparationPhase, stamp: { ...record.stamp }, lease: record.preparationLease };
  }
  function usableObservation(record, { allowExpired = false } = {}) {
    const value = record.sourceObservation;
    if (!value || record.revoked || record.controller.signal.aborted || value.mutationEpoch !== record.mutationEpoch
      || value.preparationPhase !== record.preparationPhase || !sameStamp(value.stamp, dependencies.vault.stamp())
      || value.facts.observedAt > now() || !allowExpired && now() - value.facts.observedAt >= OBSERVATION_MAX_AGE_MS
      || record.mutationPending || api.hasUnsettledWrites()) return;
    return value;
  }
  function revoke(record, code) {
    if (!record || record.revoked) return;
    invalidateObservation(record);
    if (record.mutationPending || record.preparationPending) uncertainMutation = true;
    record.revoked = true; record.controller.abort(fail(code === 'SESSION_CHANGED' ? code : 'STALE_SESSION'));
    if (current === record) current = null;
    record.detach?.();
    if (record.session) { try { Promise.resolve(onRevoke({ session: record.session, code })).catch(() => {}); } catch {} }
  }
  function own(record) {
    if (record === coldCleanup) {
      if (!sameStamp(record.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
      record.controller.signal.throwIfAborted();
      return;
    }
    if (closed || record.revoked || record.controller.signal.aborted || record.revision !== revision
      || record.session && current !== record) throw fail('STALE_SESSION');
    if (record.stamp && !sameStamp(record.stamp, dependencies.vault.stamp())) {
      revoke(record, 'SESSION_CHANGED'); throw fail('SESSION_CHANGED');
    }
  }
  function get(session, { cleanup = false } = {}) {
    if (!current || current.session !== session) throw fail('STALE_SESSION');
    own(current);
    if (current.cleanupOnly && !cleanup) throw Object.assign(fail('PLAYBACK_STATE_UNCONFIRMED'), { stage: 'cleanup-required' });
    return current;
  }
  async function guarded(record, action, { preserveCancelled, cleanup = false } = {}) {
    try { own(record);
      if (record.cleanupOnly && !cleanup) throw Object.assign(fail('PLAYBACK_STATE_UNCONFIRMED'), { stage: 'cleanup-required' });
      const result = await action(); own(record); return result; }
    catch (error) {
      try { onFailureDiagnostic(error); } catch { /* Diagnostics cannot change cleanup. */ }
      // A canceled pre-dispatch position cut has made no remote write. Keep
      // the exact owner alive so its newer Pause/Stop can fresh-read and park.
      if (failureCode(error) === 'CANCELLED' && preserveCancelled?.() === true
        && !api.hasUnsettledWrites() && !record.mutationPending && !record.revoked
        && !record.controller.signal.aborted && current === record) throw fail('CANCELLED');
      let parkedForCleanup = false;
      if (record.routeEngaged && record.onRouteParked && !record.revoked && !record.controller.signal.aborted) {
        try {
          const currentState = await read(record, { matchTrack: false });
          if (currentState.isPlaying && currentState.trackId !== record.routeCleanupTrack) throw fail('TRACK_NOT_CURRENT');
          const parked = await parkBeforeRoute(record, currentState);
          await settleAcknowledgedSelectionForRestore(record, currentState, parked);
          record.onRouteParked();
          parkedForCleanup = true;
        } catch { error = Object.assign(fail('ROUTE_SOURCE_PAUSE_UNCONFIRMED'), { cause: fail(failureCode(error)),
          retryCount: error?.retryCount, retriesExhausted: error?.retriesExhausted }); }
      }
      const code = failureCode(error);
      // The provider still needs this controller to retire capture and hold its
      // existing route. Closing it here makes that cleanup fail with STALE_SESSION.
      // The initiating operation still rejects; provider release closes it after hold.
      if (!parkedForCleanup) {
        // Keep the exact source owner for cleanup retries, but never allow new
        // Play/Seek on this failed controller. Account changes still revoke it.
        if (record.routeEngaged && current === record && !record.revoked && !record.controller.signal.aborted
          && record.revision === revision && sameStamp(record.stamp, dependencies.vault.stamp())) record.cleanupOnly = true;
        else revoke(record, code);
      }
      const failure = fail(code);
      for (const key of ['retryCount', 'retriesExhausted', 'stateMismatch', 'expectedPlaying', 'actualPlaying']) if (error?.[key] !== undefined) failure[key] = error[key];
      for (const key of ['nativeCode', 'failureCode', 'stage'])
        if (typeof error?.[key] === 'string') failure[key] = error[key];
      if (code === 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' && error.cause) failure.cause = fail(failureCode(error.cause));
      throw failure;
    }
  }
  function enqueue(record, action, options) {
    // Retired leases remain in this barrier even after close/clear removes current.
    // A late targeted pause must finish before a new session selects its track.
    const next = mutation.catch(() => {}).then(() => guarded(record, action, options));
    mutation = next; mutationSettled = false; record.queue = next;
    const settled = () => { if (mutation === next) mutationSettled = true; };
    void next.then(settled, settled); return next;
  }
  const request = (operation, record, options) => {
    if (!['state', 'devices'].includes(operation)) invalidateObservation(record);
    return api.request(operation, record, () => own(record), options);
  };
  const readOnce = async (record, { allowEmpty = false, signal, reusePreparedObservation = false, diagnosticObservation, ...options } = {}) => {
    if (reusePreparedObservation) {
      own(record);
      const saved = usableObservation(record);
      if (saved && saved.facts.deviceId === record.deviceId && (options.matchTrack === false || saved.facts.trackId === record.trackId))
        return saved.facts;
    }
    const epoch = record.mutationEpoch;
    const body = await request('state', record, { signal });
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    rememberObservation(record, body, epoch);
    try { diagnosticObservation?.(body); } catch { /* Diagnostics never change source confirmation. */ }
    return allowEmpty && body == null ? null : api.playbackFacts(body, record, { now, ...options });
  };
  const read = (record, { expectedPlaying, ...options } = {}) => retryPlayback(async attempt => {
    const facts = await readOnce(record, { ...options, reusePreparedObservation: attempt === 0 && options.reusePreparedObservation });
    if (typeof expectedPlaying === 'boolean' && facts?.isPlaying !== expectedPlaying)
      throw Object.assign(fail('PLAYBACK_STATE_UNCONFIRMED'), { stage: 'playback-facts',
        stateMismatch: 'playing-mismatch', expectedPlaying, actualPlaying: facts?.isPlaying });
    return facts;
  }, { signal: options.signal || record.controller.signal, check: () => own(record), wait,
    operation: 'state-read', report: value => console.info('[SpotifyRecovery]', JSON.stringify(value)) });
  // The deadline covers dispatch, response drain, every read and every wait, even
  // when an injected transport or producer ignores cancellation.
  async function withinConfirmation(confirmation, action) {
    const { signal, deadline } = confirmation;
    const abortedFailure = () => fail(failureCode(signal.reason));
    if (signal.aborted) throw abortedFailure();
    if (now() >= deadline) throw fail('CONTROL_TIMEOUT');
    let abort;
    const aborted = new Promise((_, reject) => { abort = () => reject(abortedFailure()); });
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([action(), aborted]); }
    catch (error) { if (signal.aborted) throw abortedFailure(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  function beginConfirmationPhase(confirmation) {
    const phaseStarted = now();
    const deadline = Math.min(confirmation.overallDeadline, phaseStarted + confirmation.phaseBudgetMs);
    const remaining = deadline - phaseStarted;
    if (remaining <= 0) throw fail('CONTROL_TIMEOUT');
    confirmation.deadline = deadline;
    confirmation.commandAt = phaseStarted;
    confirmation.observationCount = 0;
    confirmation.lastObservation = undefined;
    confirmation.signal = AbortSignal.any([confirmation.overallSignal, AbortSignal.timeout(remaining)]);
  }
  function beginConfirmation(record, before, phases = 1, phaseBudgetMs = Math.min(settleTimeoutMs, 4000)) {
    const budget = phaseBudgetMs * phases;
    const confirmation = { overallDeadline: now() + budget, phaseBudgetMs,
      overallSignal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(budget)]),
      timestampFloor: before?.serverTimestamp };
    beginConfirmationPhase(confirmation);
    return confirmation;
  }
  const pending = acknowledgment => acknowledgment?.acknowledgment === 'UNCONFIRMED';
  function checkConfirmation(record, confirmation, code = 'PLAYBACK_STATE_UNCONFIRMED') {
    own(record);
    if (confirmation.signal.aborted || now() >= confirmation.deadline) throw fail(code);
  }
  function timestampCurrent(confirmation, state) {
    const stamp = state?.serverTimestamp;
    if (stamp != null && confirmation.timestampFloor != null && stamp < confirmation.timestampFloor) return false;
    if (stamp != null) confirmation.timestampFloor = stamp;
    return true;
  }
  function reportConfirmed(operation, acknowledgment, confirmation, state, fields = {}) {
    if (!pending(acknowledgment)) return;
    reportSpotifyPlaybackControl(`playback-${operation}`, 'PUT', 200, {
      phase: 'state-confirmed', observationCount: confirmation.observationCount,
      deviceMatched: true, ...(state ? { paused: !state.isPlaying, playing: state.isPlaying } : {}), ...fields,
    });
  }
  function reportUnconfirmed(operation, acknowledgment, confirmation, error) {
    if (pending(acknowledgment) || acknowledgment === null) reportSpotifyPlaybackControl(`playback-${operation}`, 'PUT', pending(acknowledgment) ? 200 : 204, {
      phase: 'failed', ...confirmation.lastObservation, observationCount: confirmation.observationCount, errorCode: failureCode(error),
    });
  }
  const command = (operation, record, confirmation, positionMs) => withinConfirmation(confirmation,
    () => request(operation, record, { positionMs, signal: confirmation.signal }));
  async function observeCurrentTarget(record) {
    const body = await request('state', record);
    return body == null ? null : api.playbackFacts(body, { ...record, deviceId: api.describeState(body).deviceId }, { matchTrack: false, now });
  }
  async function coldBaseline(record, signal, { allowInitialNoItem = false } = {}) {
    const epoch = record.mutationEpoch;
    const privateInitial = allowInitialNoItem && typeof api.initialNoItemFacts === 'function';
    const body = await request('state', record, { signal, ...(privateInitial ? { allowInitialNoItem: true } : {}) });
    if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
    // Keep initial empty authority separate from reusable track, paused and route observations.
    if (privateInitial && api.describeState(body).itemState === 'no-item')
      return api.initialNoItemFacts(body, record);
    rememberObservation(record, body, epoch);
    return body == null ? null : api.playbackFacts(body, { ...record, deviceId: api.describeState(body).deviceId },
      { matchTrack: false, allowInactive: true, now });
  }
  async function rebuildBeforeSelection(record) {
    // A retired PUT may have reached Spotify despite cancellation. Observe the
    // account twice before another selection, without treating a different device as ours.
    const first = await observeCurrentTarget(record);
    await wait(settleIntervalMs, record.controller.signal); own(record);
    const second = await observeCurrentTarget(record);
    if (first?.deviceId !== second?.deviceId || first?.trackId !== second?.trackId || first?.isPlaying !== second?.isPlaying)
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    uncertainMutation = false;
  }
  // Playing observations use elapsed-time plausibility, never paused-position
  // equality. This observes the requested state; it does not prove PUT causality.
  function playingPosition(state, candidate, anchor, commandAt) {
    const elapsed = Math.max(0, state.observedAt - commandAt);
    if (state.positionMs < anchor - 1000 || state.positionMs > anchor + elapsed + 1000) return false;
    return !candidate || state.positionMs >= candidate.positionMs
      && state.positionMs - candidate.positionMs <= Math.max(0, state.observedAt - candidate.observedAt) + 1000;
  }
  async function confirm(record, desired, { selecting = false, positionMs, confirmation,
    strictPair = false, strictPlaying = false, unconfirmedCode } = {}) {
    let candidate;
    const code = unconfirmedCode || (positionMs == null ? 'PLAYBACK_STATE_UNCONFIRMED' : 'SEEK_UNCONFIRMED');
    const checkWindow = () => checkConfirmation(record, confirmation, code);
    // Project only facts from this operation's existing completed GET. Rejected
    // identity/state observations must remain visible without exporting their values.
    const diagnosticObservation = body => {
      confirmation.observationCount++;
      confirmation.lastObservation = {
        ...(validDeviceId(body?.device?.id) ? { deviceMatched: body.device.id === record.deviceId } : {}),
        ...(typeof body?.item?.uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(body.item.uri)
          ? { trackMatched: body.item.uri === `spotify:track:${record.trackId}` } : {}),
        ...(typeof body?.is_playing === 'boolean' ? { playing: body.is_playing } : {}),
        ...(positionMs != null && Number.isSafeInteger(body?.progress_ms) && body.progress_ms >= 0
          ? { positionWithinTolerance: body.progress_ms >= positionMs - 1000
            && body.progress_ms <= positionMs + (desired ? Math.max(0, now() - confirmation.commandAt) : 0) + 1000 } : {}),
      };
    };
    for (;;) {
      checkWindow();
      let state;
      try { state = await withinConfirmation(confirmation, () => read(record, { signal: confirmation.signal, diagnosticObservation })); checkWindow(); }
      catch (error) {
        checkWindow();
        if (!selecting || !['TRACK_NOT_CURRENT', 'PLAYBACK_UNAVAILABLE', 'DEVICE_ID_MISMATCH', 'DEVICE_INACTIVE'].includes(error?.code)) throw error;
      }
      const timestampValid = timestampCurrent(confirmation, state);
      const positionValid = state && (positionMs == null || (desired && strictPlaying
        ? playingPosition(state, candidate, positionMs, confirmation.commandAt)
        : state.positionMs >= positionMs - 1000
          && state.positionMs <= positionMs + (desired ? Math.max(0, state.observedAt - confirmation.commandAt) : 0) + 1000));
      if (state && timestampValid && state.isPlaying === desired && positionValid) {
        if (!strictPair || candidate && (desired || state.positionMs === candidate.positionMs)) {
          record.mutationPending = false; return state;
        }
        candidate = state;
      } else candidate = undefined;
      const remaining = confirmation.deadline - now();
      if (remaining <= 0) throw fail(code);
      try { await withinConfirmation(confirmation, () => wait(Math.min(settleIntervalMs, remaining), confirmation.signal)); }
      catch (error) { checkWindow(); throw error; }
      checkWindow();
    }
  }
  async function confirmOperation(record, operation, acknowledgment, desired, options) {
    const { confirmation, positionMs, strictPair, strictPlaying } = options;
    try {
      const state = await confirm(record, desired, { ...options,
        unconfirmedCode: operation === 'seek' ? 'SEEK_UNCONFIRMED' : 'PLAYBACK_STATE_UNCONFIRMED' });
      reportConfirmed(operation, acknowledgment, confirmation, state, { trackMatched: true,
        stablePosition: !desired && strictPair,
        ...(positionMs != null ? { positionWithinTolerance: desired && strictPlaying
          ? playingPosition(state, undefined, positionMs, confirmation.commandAt) : Math.abs(state.positionMs - positionMs) <= 1000 } : {}),
        ...(desired && strictPlaying ? { progressPlausible: true } : {}),
      });
      return state;
    } catch (error) { reportUnconfirmed(operation, acknowledgment, confirmation, error); throw error; }
  }
  async function setPlaying(record, playing, { positionMs, reusePreparedObservation = false } = {}) {
    const before = await read(record, { reusePreparedObservation });
    let state = before, confirmation, strictPause = false;
    if (before.isPlaying !== playing) {
      if (before.disallows[playing ? 'resuming' : 'pausing']) throw fail('CONTROL_REJECTED');
      confirmation = beginConfirmation(record, before, positionMs == null ? 1 : 2);
      const operation = playing ? 'play' : 'pause';
      const acknowledgment = await command(operation, record, confirmation);
      strictPause = false;
      // Resume keeps the existing immediate post-PUT GET. A mandatory extra wait
      // here would consume the fixed two-second capture queue before it is read.
      state = await confirmOperation(record, operation, acknowledgment, playing, { confirmation,
        strictPair: strictPause, strictPlaying: playing && pending(acknowledgment),
        positionMs: playing && pending(acknowledgment) ? before.positionMs : undefined });
    }
    if (positionMs != null && state.positionMs !== positionMs) {
      if (state.disallows.seeking) throw fail('CONTROL_REJECTED');
      if (confirmation) beginConfirmationPhase(confirmation);
      else confirmation = beginConfirmation(record, state);
      // Start exactly one corrective phase before dispatch; a 200 cannot reset it.
      const acknowledgment = await command('seek', record, confirmation, positionMs);
      state = await confirmOperation(record, 'seek', acknowledgment, playing, { positionMs, confirmation,
        strictPair: false, strictPlaying: playing && pending(acknowledgment) });
    }
    own(record);
    return state;
  }
  // Routing acquisition needs an observed paused desktop before selecting a new track, which itself starts playback.
  async function parkBeforeRoute(record, baseline) {
    if (!baseline) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    if (!baseline.isPlaying) return baseline;
    if (baseline.disallows.pausing) throw fail('CONTROL_REJECTED');
    const confirmation = beginConfirmation(record, baseline);
    const acknowledgment = await command('pause', record, confirmation);
    for (;;) {
      checkConfirmation(record, confirmation);
      const state = await withinConfirmation(confirmation, () => read(record, { matchTrack: false, signal: confirmation.signal }));
      checkConfirmation(record, confirmation); confirmation.observationCount++;
      if (state.trackId !== baseline.trackId) throw fail('TRACK_NOT_CURRENT');
      const paused = !state.isPlaying && timestampCurrent(confirmation, state);
      if (paused) { record.mutationPending = false; return state; }
      await withinConfirmation(confirmation, () => wait(settleIntervalMs, confirmation.signal));
    }
  }
  async function selectTrack(record, baseline, positionMs) {
    // Initial media loading may outlast transport controls. Observe one selection
    // within its own bounded window; never resend it or shorten measured latency.
    const confirmation = beginConfirmation(record, baseline, 1, selectionTimeoutMs);
    record.routeCleanupTrack = record.trackId;
    const acknowledgment = await command('select', record, confirmation, positionMs);
    try {
      return await confirmOperation(record, 'select', acknowledgment, true, { selecting: true, positionMs, confirmation,
        strictPair: false, strictPlaying: pending(acknowledgment) });
    } catch (error) {
      // Only an explicit, completed 204 followed by an observation deadline can
      // enter same-owner cleanup recovery. Unknown/late/error PUTs stay blocked.
      if (acknowledgment === null && record.preparationMutation?.operation === 'route-select'
        && ['PLAYBACK_STATE_UNCONFIRMED', 'CONTROL_TIMEOUT'].includes(error?.code)
        && !record.revoked && !record.controller.signal.aborted && !api.hasUnsettledWrites())
        record.preparationMutation.acknowledgedSelection = true;
      throw error;
    }
  }
  const legacyVolume = createColdVolumeReceipt(coldBootstrapDirectory);
  const preparationIntent = createDesktopPreparationIntent(coldBootstrapDirectory);
  // Old volume receipts are retained byte-for-byte. Only unknown playback writes
  // remain a source-control gate; volume uncertainty never gates a new Play.
  async function inspectLegacyPreparation() {
    try {
      let controlPending = false;
      try { controlPending = !!(await preparationIntent.snapshot()); } catch { controlPending = true; }
      const value = (await legacyVolume.snapshot())?.value;
      if (!value) return { historicalVolumeRecord: false, sourceControlUnconfirmed: controlPending, playbackUncertain: controlPending, recoverable: false };
      const playbackUncertain = controlPending || value.version !== 2 || value.playbackRequestPending !== false;
      return { historicalVolumeRecord: true, sourceControlUnconfirmed: playbackUncertain, playbackUncertain,
        recoverable: false, deviceId: value.deviceId, originalVolume: value.originalVolume };
    } catch {
      return { historicalVolumeRecord: true, sourceControlUnconfirmed: true, playbackUncertain: true, recoverable: false };
    }
  }
  async function assertPreparationAllowed() {
    await preparationIntent.assertClear();
    if ((await inspectLegacyPreparation()).sourceControlUnconfirmed || api.hasUnsettledWrites())
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
  }
  // An unknown selection cannot be retired by a later cleanup pause. A settled
  // 204 observation timeout has a separate exact-owner proof path below.
  async function preparationMutation(record, operation, action) {
    if (record.preparationPending || api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    const intent = await preparationIntent.begin(record, operation);
    const context = { intent, operation }; record.preparationMutation = context;
    record.preparationPending = true;
    try {
      const value = await action();
      await preparationIntent.complete(intent, () => { own(record); if (api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED'); });
      record.preparationPending = false; record.preparationMutation = undefined; return value;
    }
    catch (error) {
      // Rejection before dispatch, or a fully rejected/settled command, has no
      // unknown write to retain. Cancellation alone never clears an actual PUT.
      if (!record.mutationPending && !api.hasUnsettledWrites()) {
        try {
          await preparationIntent.complete(intent, () => {
            if (record.mutationPending || api.hasUnsettledWrites()) throw fail('PLAYBACK_STATE_UNCONFIRMED');
          });
          record.preparationPending = false;
          record.preparationMutation = undefined;
        } catch { /* Changed/partial storage remains an unknown preparation. */ }
      }
      if (record.preparationPending) uncertainMutation = true;
      throw error;
    }
  }
  // Retire only the exact acknowledged selection after two real same-owner
  // observations bracket cleanup. Native release still independently proves
  // paused source, stopped PCM and exact original per-app route restoration.
  async function settleAcknowledgedSelectionForRestore(record, before, paused) {
    const context = record.preparationMutation;
    if (!record.preparationPending || context?.operation !== 'route-select' || context.acknowledgedSelection !== true
      || before.isPlaying !== true || before === paused) return;
    const check = () => {
      own(record);
      if (record.preparationMutation !== context || record.mutationPending || api.hasUnsettledWrites()
        || !record.routeEngaged || !Number.isSafeInteger(record.preparationLease?.generation) || record.preparationLease.generation < 1
        || record.routeProofGeneration !== record.preparationLease.generation
        || before.deviceId !== record.deviceId || before.trackId !== record.trackId
        || paused.deviceId !== record.deviceId || paused.trackId !== record.trackId || paused.isPlaying !== false
        || before.observedAt > paused.observedAt || paused.observedAt > now()
        || now() - before.observedAt >= OBSERVATION_MAX_AGE_MS
        || before.serverTimestamp != null && paused.serverTimestamp != null && paused.serverTimestamp < before.serverTimestamp)
        throw fail('PLAYBACK_STATE_UNCONFIRMED');
    };
    check(); await preparationIntent.complete(context.intent, check); check();
    record.preparationPending = false; record.preparationMutation = undefined;
  }
  function recordFor(session) {
    return { session, revision, controller: new AbortController(), queue: Promise.resolve(), revoked: false, mutationEpoch: ++mutationGeneration, preparationPhase: 'baseline' };
  }
  function routedCallbacks(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['beforeSelect', 'afterSelect', 'afterPark'].includes(key))
      || typeof value.beforeSelect !== 'function' || typeof value.afterSelect !== 'function' || typeof value.afterPark !== 'function') throw fail('PROTOCOL_INVALID');
    return value;
  }
  async function protectedRouteSelection(record, positionMs, callbacks, baseline, { deferPositionUntilPlay = false, positionStartIntentId, isStartIntentCurrent } = {}) {
    const hooks = routedCallbacks(callbacks);
    if (!position(positionMs, record.durationMs)) throw fail('PROTOCOL_INVALID');
    setPreparationPhase(record, 'baseline');
    const before = baseline || await read(record, { matchTrack: false });
    const paused = before?.isPlaying
      ? await preparationMutation(record, 'route-park-before', () => parkBeforeRoute(record, before)) : before;
    own(record);
    if (!paused || paused.deviceId !== record.deviceId || paused.isPlaying || !validTrackId(paused.trackId))
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    record.routeEngaged = true; record.routeCleanupTrack = paused.trackId;
    record.routePreparedParked = undefined;
    record.routeBaselineUri = `spotify:track:${paused.trackId}`;
    routeSources.get(record.sourceSession)?.routeProofController?.abort();
    record.routeProofController?.abort();
    record.routeProofController = new AbortController(); routeSources.set(record.sourceSession, record);
    record.preparationLease = { selectedUri: `spotify:track:${record.trackId}` };
    const baselineObservation = usableObservation(record);
    if (baselineObservation) baselineObservation.lease = record.preparationLease;
    record.preparationObservationOpen = true;
    await hooks.beforeSelect(paused); own(record);
    // A pre-route cold selection does not prove a Spotify stream ever ran on
    // this target. Materialize under this retained route, then await the native
    // endpoint witness before pausing or acquiring any 44.1 capture lease.
    const coldReceipt = record.coldPreparedSelection;
    if (coldReceipt && usableObservation(record) === coldReceipt && coldReceipt.facts.trackId === record.trackId
      && coldReceipt.facts.deviceId === record.deviceId && coldReceipt.facts.isPlaying === false
      && coldReceipt.facts.positionMs === positionMs) {
      // Preserve the existing post-acquisition source check; it can reject an
      // external source change, but cannot stand in for target stream activity.
      const unchanged = await read(record);
      if (unchanged.isPlaying || unchanged.positionMs !== positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
    }
    // Local cold discovery already selected this track. A fresh read after route
    // acquisition permits Resume instead of selecting it again; target activity
    // and the subsequent pause are still independently witnessed on the new route.
    const coldCurrent = reuseColdTrack && coldReceipt ? await read(record) : null;
    const resumeCold = coldCurrent && !coldCurrent.isPlaying && coldCurrent.trackId === record.trackId
      && coldCurrent.deviceId === record.deviceId && deferPositionUntilPlay;
    record.coldPreparedSelection = undefined;
    setPreparationPhase(record, 'selected');
    const selected = await preparationMutation(record, 'route-select', () => resumeCold
      ? setPlaying(record, true) : selectTrack(record, paused, positionMs));
    own(record);
    await hooks.afterSelect(selected); own(record);
    const parked = await preparationMutation(record, 'route-park', () => setPlaying(record, false,
      { ...(deferPositionUntilPlay ? {} : { positionMs }), reusePreparedObservation: true }));
    own(record);
    if (parked.deviceId !== record.deviceId || parked.trackId !== record.trackId || parked.isPlaying)
      throw fail('PLAYBACK_STATE_UNCONFIRMED');
    record.routePreparedParked = { trackId: parked.trackId, positionMs: parked.positionMs, durationMs: parked.durationMs };
    await hooks.afterPark(parked); own(record); record.onRouteParked?.();
    if (deferPositionUntilPlay) {
      const observed = usableObservation(record);
      if (!observed || observed.lease !== record.preparationLease || observed.facts.isPlaying
        || observed.facts.positionMs !== parked.positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      // Initial selected activity and this actual Pause were both proved by the
      // ordinary native preparation. No resume-transfer receipt is manufactured.
      const pendingStart = Object.freeze({ requestedPositionMs: positionMs, resumeIntentId: positionStartIntentId });
      record.pendingPositionStart = { token: pendingStart, observation: observed, isIntentCurrent: isStartIntentCurrent };
      return { ...parked, pendingStart };
    }
    return parked;
  }
  // Cold identity discovery is still limited to the existing exact no-session
  // branch. Its brief select uses the user's current volume, then parks before
  // native route acquisition. Post-route target activity still needs its own selection fence.
  async function establishColdIdentity(record, inspect, baseline, device) {
    let selected = false, inspectionCause, inspecting = false;
    try {
      // The select request already targets device_id. Its real state confirmation
      // establishes activation; a separate transfer adds no source identity proof.
      const active = await preparationMutation(record, 'cold-select', () => selectTrack(record, baseline, 0)); selected = true;
      // A source Play ACK can precede creation of its CoreAudio session. Keep
      // this exact selection playing until native identity exists, then park.
      // Pausing first can prevent the session from ever materializing.
      // Wrapper cold loading has a 30 s selection budget; the CoreAudio session can
      // appear after the bridge ACK. Do not shrink that same startup to the 4 s control budget.
      const window = beginConfirmation(record, undefined, 1, selectionTimeoutMs); inspecting = true;
      for (;;) {
        checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
        try { await withinConfirmation(window, () => inspect(active)); break; }
        catch (error) {
          inspectionCause = error;
          checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
          if (['CANCELLED', 'SUPERSEDED', 'STALE_SESSION', 'CLOSED', 'SESSION_CHANGED'].includes(error?.code)) throw error;
          if (error?.name === 'AbortError') throw fail('CANCELLED');
          if (!['EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN', 'SPOTIFY_CANDIDATE_SET_CHANGED'].includes(error?.code)) throw error;
        }
        // Session discovery can lag the acknowledged select. Only this exact
        // no-session or still-starting candidate-set result retries with a complete
        // new native inspection, within the original deadline and no new PUT.
        try { await withinConfirmation(window, () => wait(Math.min(settleIntervalMs, window.deadline - now()), window.signal)); }
        catch (error) { checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED'); throw error; }
      }
      checkConfirmation(record, window, 'BOOTSTRAP_IDENTITY_UNCONFIRMED');
      const parked = await preparationMutation(record, 'cold-park', () => setPlaying(record, false, { reusePreparedObservation: true }));
      await inspect(parked);
      reportSpotifyColdBootstrap(record.session, 'inspect', 'completed', { selectInvoked: true, selectConfirmed: true });
      inspecting = false;
      record.coldPreparedSelection = usableObservation(record);
      return parked;
    } catch (error) {
      if (inspecting) reportSpotifyColdBootstrap(record.session, 'inspect', 'failed', { errorCode: error,
        ...(inspectionCause ? { causeCode: inspectionCause } : {}), selectInvoked: selected, selectConfirmed: selected });
      if (inspectionCause && error.code === 'BOOTSTRAP_IDENTITY_UNCONFIRMED') {
        error.cause = inspectionCause;
        error.failureCode = inspectionCause.nativeCode || inspectionCause.failureCode || inspectionCause.code;
        error.stage = inspectionCause.stage || 'identity-inspect';
      }
      // Selecting may have succeeded before an inspection failure. Observe and
      // pause only that exact source; never seek, select, transfer or change volume.
      if (selected || record.preparationPending) {
        coldCleanup = { ...record, controller: new AbortController() };
        try {
          if (record.preparationPending) await setPlaying(coldCleanup, false);
          else await preparationMutation(coldCleanup, 'cleanup-pause', () => setPlaying(coldCleanup, false));
        }
        catch { /* Unknown playback remains retained by the controller barrier. */ }
        finally { coldCleanup.controller.abort(); coldCleanup = undefined; }
      }
      throw error;
    }
  }
  // Speculative inventory has an explicit source owner and never enters the
  // ambient setup handoff. It confers no playback or route authority.
  function prefetchedDevices(receipt, { signal, session, consume = false } = {}) {
    const saved = receipt && devicePreparations.get(receipt);
    if (consume && receipt) devicePreparations.delete(receipt);
    if (!saved || saved.session !== session || signal && saved.signal !== signal
      || saved.signal.aborted || saved.revision !== revision || closed) throw fail('CANCELLED');
    if (!sameStamp(saved.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
    if (saved.observedAt > now() || now() - saved.observedAt >= OBSERVATION_MAX_AGE_MS) saved.invalidated = true;
    if (saved.invalidated) return null;
    return saved;
  }
  async function listDevices({ signal, forPreparation = false, session } = {}) {
    if (closed || signal?.aborted) throw fail('CANCELLED');
    if (session != null && (!validSessionId(session) || !signal)) throw fail('PROTOCOL_INVALID');
    const record = recordFor(null); record.readOnly = session != null; observations.add(record);
    const abort = () => revoke(record, 'CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
    try { return await guarded(record, async () => {
      record.stamp = await api.authorize(() => own(record), { readOnly: record.readOnly });
      const body = await request('devices', record, { signal });
      const devices = normalizeDevices(body);
      const snapshot = { body, stamp: { ...record.stamp }, observedAt: now() };
      if (session != null) {
        const receipt = Object.freeze({});
        devicePreparations.set(receipt, { ...snapshot, session, signal, revision });
        return receipt;
      }
      if (forPreparation === true) preparationDevices = snapshot;
      return devices;
    }); } finally { observations.delete(record); signal?.removeEventListener('abort', abort); revoke(record, 'CLOSED'); }
  }
  return {
    inspectLegacyPreparation,
    async inspectColdRecovery() {
      const history = await inspectLegacyPreparation();
      return { ...history, required: false, archived: history.historicalVolumeRecord,
        unresolvedHistorical: history.historicalVolumeRecord };
    },
    async hasOwnedColdRecovery() { return false; },
    async checkColdRecovery() { return this.inspectColdRecovery(); },
    listDevices,
    prefetchDevices({ signal, session } = {}) {
      if (!validSessionId(session) || !signal) throw fail('PROTOCOL_INVALID');
      return listDevices({ signal, session });
    },
    readPrefetchedDevices(receipt, options) {
      const snapshot = prefetchedDevices(receipt, options);
      return snapshot ? normalizeDevices(snapshot.body) : null;
    },
    async prepare({ session, sourceSession = session, deviceId, trackId, durationMs, positionMs = 0, restoreSavedTarget = false, signal,
      beforeSelect, afterSelect, onRouteParked, coldBootstrap, coldBootstrapRequired = true, routedPreparation, retainedSourceTrackId,
      preparationDevices: preparationReceipt, deferPositionUntilPlay = false, positionStartIntentId, isStartIntentCurrent } = {}) {
      if (closed || signal?.aborted) throw fail('CANCELLED');
      if (!validSessionId(session) || !validSessionId(sourceSession) || !validDeviceId(deviceId) || !validTrackId(trackId)
        || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000 || !position(positionMs, durationMs)
        || retainedSourceTrackId != null && (!validTrackId(retainedSourceTrackId) || !routedPreparation || coldBootstrap != null)
        || typeof restoreSavedTarget !== 'boolean' || typeof coldBootstrapRequired !== 'boolean'
        || typeof deferPositionUntilPlay !== 'boolean' || deferPositionUntilPlay && (!routedPreparation
          || !validSessionId(positionStartIntentId) || typeof isStartIntentCurrent !== 'function')
        || coldBootstrap != null && (typeof coldBootstrap !== 'function'
          || typeof beforeSelect !== 'function' && routedPreparation == null || !restoreSavedTarget || positionMs !== 0)) throw fail('PROTOCOL_INVALID');
      if (routedPreparation != null) {
        routedCallbacks(routedPreparation);
        if (beforeSelect != null || afterSelect != null || !restoreSavedTarget) throw fail('PROTOCOL_INVALID');
      }
      const scopedDevices = preparationReceipt ? prefetchedDevices(preparationReceipt, { session, consume: true }) : null;
      const previous = current;
      for (const [oldSession, source] of routeSources) {
        if (oldSession !== sourceSession) { source.routeProofController.abort(); routeSources.delete(oldSession); }
      }
      revoke(previous, 'SUPERSEDED'); revision++;
      const record = Object.assign(recordFor(session), { sourceSession, deviceId, trackId, durationMs, onRouteParked }); current = record;
      const abort = () => revoke(record, 'CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
      record.detach = () => signal?.removeEventListener('abort', abort);
      return enqueue(record, async () => {
        // Retire a previously dispatched command before selecting a new track. Aborting
        // its HTTP request does not itself prove the service has settled that command.
        await previous?.queue.catch(() => {}); own(record);
        await assertPreparationAllowed(); own(record);
        record.stamp = await api.authorize(() => own(record));
        const handoff = scopedDevices || preparationDevices; preparationDevices = undefined;
        let device, deviceObservedAt;
        if (handoff && sameStamp(handoff.stamp, record.stamp) && handoff.observedAt <= now()
          && now() - handoff.observedAt < OBSERVATION_MAX_AGE_MS) {
          try { device = requireDevice(handoff.body, deviceId); deviceObservedAt = handoff.observedAt; } catch { /* Fresh GET retains the ordinary target validation. */ }
        }
        if (!device) { device = requireDevice(await request('devices', record), deviceId); deviceObservedAt = now(); }
        record.preparationDevice = { device, observedAt: deviceObservedAt, stamp: { ...record.stamp }, mutationEpoch: record.mutationEpoch };
        if (!device.isActive && !restoreSavedTarget) throw fail('DEVICE_INACTIVE');
        if (!device.isActive && (beforeSelect || routedPreparation) && !coldBootstrap) throw fail('DEVICE_INACTIVE');
        // Only the active VB preparation path can restore its saved target.
        // Passive reads never transfer, select, pause or change volume.
        if (uncertainMutation) await rebuildBeforeSelection(record);
        let baseline;
        if (coldBootstrap) {
          baseline = await coldBaseline(record, undefined, { allowInitialNoItem: true });
          if (coldBootstrapRequired || !device.isActive || baseline === null || baseline.itemState === 'no-item' || baseline.isActive === false || baseline.deviceId !== deviceId)
            baseline = await establishColdIdentity(record, coldBootstrap, baseline, device);
        } else baseline = !device.isActive ? await coldBaseline(record)
          : await read(record, { matchTrack: false, allowEmpty: restoreSavedTarget });
        if (retainedSourceTrackId != null && (baseline?.deviceId !== deviceId || baseline?.trackId !== retainedSourceTrackId))
          throw fail('TRACK_NOT_CURRENT');
        if (uncertainMutation) {
          // Cancellation/timeout cannot undo an accepted remote PUT. Rebuild fresh
          // stable observations before proceeding; this is not an atomicity guarantee.
          await wait(settleIntervalMs, record.controller.signal); own(record);
          const rebuilt = await read(record, { matchTrack: false, allowEmpty: restoreSavedTarget });
          if (rebuilt?.trackId !== baseline?.trackId || rebuilt?.isPlaying !== baseline?.isPlaying) throw fail('PLAYBACK_STATE_UNCONFIRMED');
          uncertainMutation = false;
        }
        if (routedPreparation) return protectedRouteSelection(record, positionMs, routedPreparation, baseline, { deferPositionUntilPlay, positionStartIntentId, isStartIntentCurrent });
        if (beforeSelect) {
          const paused = await parkBeforeRoute(record, baseline);
          record.routeEngaged = true; record.routeCleanupTrack = baseline.trackId;
          record.routeBaselineUri = baseline.trackId == null ? null : `spotify:track:${baseline.trackId}`;
          routeSources.get(record.sourceSession)?.routeProofController?.abort();
          record.routeProofController = new AbortController(); routeSources.set(record.sourceSession, record);
          await beforeSelect(paused); own(record);
        }
        const selected = await selectTrack(record, baseline, positionMs);
        if (afterSelect) { await afterSelect(selected); own(record); }
        return setPlaying(record, false, { positionMs });
      });
    },
    async prepareOwnedRoute(session, { positionMs, beforeSelect, afterSelect, afterPark, deferPositionUntilPlay = false, positionStartIntentId, isStartIntentCurrent } = {}) {
      const record = get(session), hooks = routedCallbacks({ beforeSelect, afterSelect, afterPark });
      if (typeof deferPositionUntilPlay !== 'boolean' || deferPositionUntilPlay && (!validSessionId(positionStartIntentId) || typeof isStartIntentCurrent !== 'function')
        || !position(positionMs, record.durationMs)) throw fail('PROTOCOL_INVALID');
      return enqueue(record, async () => {
        await assertPreparationAllowed(); own(record);
        // Reopening an existing source cannot claim a different externally selected song.
        setPreparationPhase(record, 'baseline');
        const baseline = await read(record);
        return protectedRouteSelection(record, positionMs, hooks, baseline, { deferPositionUntilPlay, positionStartIntentId, isStartIntentCurrent });
      });
    },
    async resumeOwnedRoute(session, { positionMs, pausedProofTransferId, resumeIntentId, isIntentCurrent = () => true, deferPositionUntilPlay = false, beforePosition, afterPark } = {}) {
      const record = get(session);
      if (!position(positionMs, record.durationMs) || typeof beforePosition !== 'function' || typeof afterPark !== 'function'
        || typeof deferPositionUntilPlay !== 'boolean' || typeof isIntentCurrent !== 'function'
        || deferPositionUntilPlay && !validSessionId(resumeIntentId))
        throw fail('PROTOCOL_INVALID');
      return enqueue(record, async () => {
        await assertPreparationAllowed(); own(record);
        const offered = record.pausedResumeTransfer; record.pausedResumeTransfer = undefined;
        const eligible = offered?.id === pausedProofTransferId && /^[a-f0-9-]{36}$/.test(resumeIntentId || '')
          && offered.observation === usableObservation(record) && offered.observation.lease === record.preparationLease
          && offered.observation.facts.observedAt <= now() && now() - offered.observation.facts.observedAt < TRANSFER_MAX_AGE_MS
          && isIntentCurrent();
        const transfer = eligible ? { pausedProofTransferId, resumeIntentId } : undefined;
        record.resumeProofTransfer = transfer ? { ...transfer, observation: offered.observation, isIntentCurrent } : undefined;
        if (!transfer) setPreparationPhase(record, 'baseline');
        const baseline = transfer ? offered.observation.facts : await read(record);
        if (baseline.isPlaying || !record.routeEngaged) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.routePreparedParked = undefined;
        record.routeBaselineUri = `spotify:track:${record.trackId}`;
        if (!transfer) record.preparationLease = { selectedUri: record.routeBaselineUri };
        const observation = usableObservation(record);
        if (observation) observation.lease = record.preparationLease;
        record.preparationObservationOpen = true;
        try { await beforePosition(baseline, transfer); own(record); }
        finally { record.resumeProofTransfer = undefined; }
        let currentObservation = usableObservation(record);
        // Native consumes the sub-500 ms transfer. Later preparation follows
        // the existing five-second selected-observation lifetime, never a refreshed timestamp.
        let positionBaseline = currentObservation?.lease === record.preparationLease
          && currentObservation.facts.deviceId === record.deviceId && currentObservation.facts.trackId === record.trackId
          && currentObservation.facts.isPlaying === false ? currentObservation.facts : null;
        // The consumed native transfer keeps the SAME real selected receipt.
        // If the handoff expired, native has instead verified a fresh baseline.
        // Acquire a genuinely new selected-phase paused GET before completing
        // preparation; its old checkpoint remains distinct from the target.
        if (deferPositionUntilPlay && isIntentCurrent()
          && !(transfer && currentObservation === offered.observation && positionBaseline && record.preparationPhase === 'selected')) {
          setPreparationPhase(record, 'selected');
          positionBaseline = await read(record); own(record);
          currentObservation = usableObservation(record);
          if (positionBaseline.isPlaying || !currentObservation || currentObservation.lease !== record.preparationLease)
            throw Object.assign(fail('PLAYBACK_STATE_UNCONFIRMED'), { diagnostic: {
              phase: 'resume-selected-observation', playing: positionBaseline.isPlaying,
              observationPresent: Boolean(record.sourceObservation), usable: Boolean(currentObservation),
              leaseMatched: record.sourceObservation?.lease === record.preparationLease,
              observedAgeMs: record.sourceObservation ? now() - record.sourceObservation.facts.observedAt : null,
              epochMatched: record.sourceObservation?.mutationEpoch === record.mutationEpoch,
              phaseMatched: record.sourceObservation?.preparationPhase === record.preparationPhase,
              mutationPending: record.mutationPending === true, writesPending: api.hasUnsettledWrites(),
            } });
        }
        if (deferPositionUntilPlay && positionBaseline && record.preparationPhase === 'selected' && isIntentCurrent()) {
          if (positionBaseline.disallows.seeking || positionBaseline.disallows.resuming) throw fail('CONTROL_REJECTED');
          record.routePreparedParked = { trackId: positionBaseline.trackId, positionMs: positionBaseline.positionMs,
            durationMs: positionBaseline.durationMs };
          await afterPark(positionBaseline); own(record);
          // Native completePreparation rechecks an actual selected paused receipt.
          // The requested position has not been written or observed yet.
          const pendingStart = Object.freeze({ requestedPositionMs: positionMs, resumeIntentId });
          record.pendingPositionStart = { token: pendingStart, observation: currentObservation, isIntentCurrent };
          record.onRouteParked?.();
          return { ...positionBaseline, pendingStart };
        }
        setPreparationPhase(record, 'selected');
        const parked = await preparationMutation(record, 'route-park', async () => {
          if (!positionBaseline) return setPlaying(record, false, { positionMs });
          // This fresh observation belongs to this resume transaction. Changing
          // proof phase does not require reading the same pre-seek state twice.
          // The seek's confirmation below establishes new selected-phase facts.
          if (positionBaseline.positionMs === positionMs) return read(record);
          if (positionBaseline.disallows.seeking) throw fail('CONTROL_REJECTED');
          const confirmation = beginConfirmation(record, positionBaseline);
          const acknowledgment = await command('seek', record, confirmation, positionMs);
          return confirmOperation(record, 'seek', acknowledgment, false, { positionMs, confirmation, strictPair: false });
        });
        own(record);
        if (parked.isPlaying || parked.deviceId !== record.deviceId || parked.trackId !== record.trackId
          || Math.abs(parked.positionMs - positionMs) > 1000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        // Spotify seek confirmation is bounded, not sample-exact. Keep its actual
        // observed checkpoint for the native paused proof instead of rejecting rounded positions.
        record.routePreparedParked = { trackId: parked.trackId, positionMs: parked.positionMs, durationMs: parked.durationMs };
        await afterPark(parked); own(record); record.onRouteParked?.();
        return parked;
      });
    },
    async observeExternalSelection(session, beforePause, afterPause) { const record=get(session);
      return enqueue(record,async()=>{
        const facts=await read(record,{matchTrack:false});
        if(facts.trackId===record.trackId)return null;
        if(!record.routeEngaged||!validTrackId(facts.trackId))throw fail('TRACK_NOT_CURRENT');
        await beforePause(facts);own(record);
        const parked=await parkBeforeRoute(record,facts);own(record);
        const previous=record.trackId;
        // Explicit source handoff: ordinary reads keep their exact-track checks.
        record.trackId=parked.trackId;record.durationMs=parked.durationMs;
        record.routeCleanupTrack=parked.trackId;invalidateObservation(record);
        await afterPause(parked);own(record);
        record.routeBaselineUri=`spotify:track:${parked.trackId}`;record.routePreparedParked=undefined;
        return {...parked,previousTrackId:previous};
      });
    },
    async readState(session, { forPreparation = false, expectedPlaying } = {}) { const record = get(session);
      return enqueue(record, () => read(record, { expectedPlaying,
        reusePreparedObservation: forPreparation && record.preparationObservationOpen === true })); },
    async routeSourceControl(input, { signal: callerSignal } = {}) {
      const record = routeSources.get(input?.session);
      if (!record) throw fail('STALE_SESSION');
      const selectedUri = `spotify:track:${record.trackId}`;
      const seekPark = input.requireSeekParkEvidence === true;
      if (input.requireSeekParkEvidence != null && typeof input.requireSeekParkEvidence !== 'boolean'
        || seekPark && (input.action !== 'read' || !validSessionId(input.seekTransaction) || !validSessionId(input.seekToken)
          || input.restoreOperationId != null || input.allowPreviousPaused === true)
        || !seekPark && (input.seekTransaction != null || input.seekToken != null)) throw fail('PROTOCOL_INVALID');
      const seekEvidence = () => seekPark ? readSeekParkEvidence(record.sourceSession, input.generation, input.seekTransaction, input.seekToken) : null;
      const captureQuiescent = () => seekPark ? seekEvidence() != null : readRoutePcmEvidence(record.sourceSession, input.generation) === true;
      const reuse = input.requirePreparationObservation === true;
      const transfer = input.pausedProofTransferId != null;
      const transferFallback = input.pausedProofTransferFallback === true;
      const transferContext = record.resumeProofTransfer;
      if (transfer || transferFallback) {
        if (!transferContext || !reuse || input.action !== 'read'
          || input.requirePreparedSelection !== true || input.restoreOperationId != null
          || transfer && (transferFallback || transferContext.pausedProofTransferId !== input.pausedProofTransferId
            || transferContext.resumeIntentId !== input.resumeIntentId || input.preparationPhase !== 'selected'
            || usableObservation(record, { allowExpired: true }) !== transferContext.observation)
          || transferFallback && (input.resumeIntentId != null || input.preparationPhase !== 'baseline')) throw fail('STALE_SESSION');
        if (transferFallback) { transferContext.fallback = true; setPreparationPhase(record, 'baseline'); }
        if (transfer && transferContext.fallback) throw fail('STALE_SESSION');
      }
      const heldPause = input.pauseObservationOnly === true;
      const pauseFallback = input.pauseFreshFallback === true;
      const pausedHoldProof = (heldPause || pauseFallback) && record.pausedHoldProof;
      if (input.pauseObservationOnly != null && typeof input.pauseObservationOnly !== 'boolean'
        || input.pauseFreshFallback != null && typeof input.pauseFreshFallback !== 'boolean'
        || heldPause && (!reuse || input.preparationPhase !== 'selected' || input.action !== 'read'
          || input.requirePreparedSelection === true || input.restoreOperationId != null || input.allowPreviousPaused === true
          || pauseFallback || !pausedHoldProof || !pausedHoldProof.isBound() || pausedHoldProof.fallback)
        || pauseFallback && (reuse || input.preparationPhase != null || input.action !== 'read'
          || input.requirePreparedSelection === true || input.restoreOperationId != null || input.allowPreviousPaused === true
          || !pausedHoldProof || !pausedHoldProof.isBound()
          || !pausedHoldProof.fallback && now() - pausedHoldProof.observation.facts.observedAt < OBSERVATION_MAX_AGE_MS))
        throw fail('PLAYBACK_STATE_UNCONFIRMED');
      if (heldPause || pauseFallback) pausedHoldProof.bindSignal(callerSignal);
      if (pauseFallback) pausedHoldProof.fallback = true;
      const restoring = input.restoreOperationId != null;
      const changedPausedRestore = input.allowChangedTrackPausedForRestore === true;
      const emptyRestore = input.allowEmptyPlayerForRestore === true;
      if (input.allowEmptyPlayerForRestore != null && typeof input.allowEmptyPlayerForRestore !== 'boolean'
        || emptyRestore && (!restoring || input.action !== 'read')) throw fail('PROTOCOL_INVALID');
      if (input.allowChangedTrackPausedForRestore != null && typeof input.allowChangedTrackPausedForRestore !== 'boolean'
        || changedPausedRestore && (!restoring || input.action !== 'read')) throw fail('PROTOCOL_INVALID');
      if (restoring && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.restoreOperationId)
        || input.action !== 'read' || reuse || input.requirePreparedSelection === true || input.preparationPhase != null
        || input.preparationSelectedSourceUri != null)) throw fail('PROTOCOL_INVALID');
      if (input.requirePreparationObservation != null && typeof input.requirePreparationObservation !== 'boolean'
        || reuse && (input.action !== 'read' || !['baseline', 'selected'].includes(input.preparationPhase))
        || !reuse && input.preparationPhase != null) throw fail('PROTOCOL_INVALID');
      if (reuse && (record.revoked || input.preparationPhase !== record.preparationPhase)) throw fail('STALE_SESSION');
      if ((reuse || restoring) && (record.preparationPending || record.mutationPending || api.hasUnsettledWrites())) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      if (input.requirePreparedSelection != null && typeof input.requirePreparedSelection !== 'boolean'
        || input.requirePreparedSelection === true && (input.action !== 'read' || input.preparationSelectedSourceUri !== selectedUri)
        || input.requirePreparedSelection !== true && input.preparationSelectedSourceUri != null) throw fail('PROTOCOL_INVALID');
      if (!record.routeEngaged || !['read', 'pause'].includes(input.action) || input.sourceDeviceId !== record.deviceId
        || !Number.isSafeInteger(input.generation) || input.generation < 1
        || record.routeProofGeneration != null && (input.generation < record.routeProofGeneration
          || record.revoked && input.generation !== record.routeProofGeneration)
        || ![record.routeBaselineUri, selectedUri].includes(input.expectedSourceUri)
        || input.allowPreviousPaused === true && ![record.routeBaselineUri, selectedUri].includes(input.pausedPreviousUri))
        throw fail('PROTOCOL_INVALID');
      if (reuse) {
        if (record.preparationLease?.generation != null && record.preparationLease.generation !== input.generation) throw fail('STALE_SESSION');
        if (!record.preparationLease) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        record.preparationLease.generation = input.generation;
      }
      record.routeProofGeneration = input.generation;
      // Ordinary playback may already be revoked. Keep only this exact route's read/pause authority until
      // native release/recovery finishes; no retained method can play, select, seek or transfer a source.
      const checkProof = () => {
        if (closed || routeSources.get(record.sourceSession) !== record || record.routeProofController.signal.aborted
          || reuse && (record.revoked || record.controller.signal.aborted)) throw fail('STALE_SESSION');
        if (!sameStamp(record.stamp, dependencies.vault.stamp())) throw fail('SESSION_CHANGED');
        if ((transfer || transferFallback) && (record.resumeProofTransfer !== transferContext
          || !captureQuiescent())) throw fail('STALE_SESSION');
        if ((heldPause || pauseFallback) && (!pausedHoldProof.isBound() || !captureQuiescent()))
          throw fail('PLAYBACK_STATE_UNCONFIRMED');
      };
      let restoreContext;
      if (restoring) {
        const scope = JSON.stringify([input.generation, input.sourceDeviceId, input.expectedSourceUri,
          input.allowPreviousPaused === true, input.pausedPreviousUri || null, changedPausedRestore, emptyRestore]);
        const previous = record.restoreObservation;
        if (previous?.operationId === input.restoreOperationId) {
          if (previous.scope !== scope) throw fail('PROTOCOL_INVALID');
          restoreContext = previous;
        } else {
          record.restoreOperations ||= new Set();
          if (record.restoreOperations.has(input.restoreOperationId) || record.restoreOperations.size >= 128) throw fail('STALE_SESSION');
          record.restoreOperations.add(input.restoreOperationId);
          restoreContext = { operationId: input.restoreOperationId, scope, mutationEpoch: record.mutationEpoch };
          record.restoreObservation = restoreContext;
        }
      }
      const proof = { ...record, controller: record.routeProofController };
      // Startup may reuse one bounded actual source observation. Each normal restore
      // starts with its own source read; rollback/recovery reads remain independent.
      // No branch queries or changes Spotify volume.
      const proofBudgetMs = input.action === 'read' ? 4000 : 10000;
      const signal = AbortSignal.any([record.routeProofController.signal, callerSignal || new AbortController().signal, AbortSignal.timeout(proofBudgetMs)]);
      const deadline = now() + proofBudgetMs;
      const proofWindow = budget => {
        const remaining = Math.min(budget, deadline - now());
        if (remaining <= 0) throw fail('CONTROL_TIMEOUT');
        return { deadline: now() + remaining, signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]) };
      };
      let capturedObservation, capturedRestore;
      const observe = async (matchSelected = false, window = proofWindow(4000)) => withinConfirmation(window, async () => {
        window.signal.throwIfAborted(); checkProof();
        const requireParked = input.requirePreparedSelection === true && record.routePreparedParked;
        let saved = reuse && usableObservation(record, { allowExpired: heldPause || transfer });
        if (saved && saved.lease !== record.preparationLease) saved = undefined;
        if (heldPause && saved !== pausedHoldProof.observation) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        if (transfer && saved !== transferContext.observation) throw fail('STALE_SESSION');
        let facts;
        if (restoring) {
          if (restoreContext.invalidated || restoreContext.mutationEpoch !== record.mutationEpoch)
            throw fail('STALE_SESSION');
          if (!restoreContext.observation) {
            if (!restoreContext.task) restoreContext.task = (async () => {
              const epoch = record.mutationEpoch;
              const body = await api.request('state', proof, checkProof, { signal: window.signal }); checkProof(); window.signal.throwIfAborted();
              if (epoch !== record.mutationEpoch || record.restoreObservation !== restoreContext || restoreContext.invalidated) throw fail('STALE_SESSION');
              if (body === null && emptyRestore) {
                // API GET204 attests an empty account player, never a paused
                // selected device. Native must independently prove this exact
                // route owner's all-endpoint quiescence before each restore write.
                if (record.preparationPending || record.mutationPending || api.hasUnsettledWrites()
                  || !captureQuiescent()) throw fail('PLAYBACK_STATE_UNCONFIRMED');
                return restoreContext.observation = { facts: Object.freeze({ emptyPlayer: true,
                  deviceId: record.deviceId, trackId: null, isPlaying: null, positionMs: null, observedAt: now() }),
                  observationGeneration: ++observationGeneration, mutationEpoch: epoch };
              }
              const { trackId, durationMs } = api.describeState(body);
              if (!trackId || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3600000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
              const actual = api.playbackFacts(body, { ...proof, trackId, durationMs }, { now });
              return restoreContext.observation = { facts: actual, observationGeneration: ++observationGeneration, mutationEpoch: epoch };
            })();
            await restoreContext.task;
          }
          capturedRestore = restoreContext.observation;
          facts = capturedRestore.facts;
          if (facts.observedAt > now() || now() - facts.observedAt >= OBSERVATION_MAX_AGE_MS) throw fail('STALE_SESSION');
        } else if (saved) facts = saved.facts;
        else {
          const epoch = record.mutationEpoch;
          const load = async () => {
            const body = await api.request('state', proof, checkProof, { signal: window.signal }); checkProof(); window.signal.throwIfAborted();
            if (epoch !== record.mutationEpoch) throw fail('STALE_SESSION');
            if (reuse) rememberObservation(record, body, epoch);
            return api.playbackFacts(body, proof, { matchTrack: matchSelected || !!requireParked, now });
          };
          if (reuse) {
            if (!record.observationRead || record.observationRead.epoch !== epoch) {
              const activeRead = { epoch, task: load() }; record.observationRead = activeRead;
              void activeRead.task.finally(() => { if (record.observationRead === activeRead) record.observationRead = undefined; }).catch(() => {});
            }
            await record.observationRead.task;
            saved = usableObservation(record);
            if (!saved || saved.lease !== record.preparationLease) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            facts = saved.facts;
          } else facts = await load();
        }
        if (requireParked && (facts.isPlaying || facts.trackId !== requireParked.trackId
          || facts.positionMs !== requireParked.positionMs)) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        const uri = facts.trackId == null ? null : `spotify:track:${facts.trackId}`;
        if (!facts.emptyPlayer && uri !== input.expectedSourceUri && !(input.allowPreviousPaused === true && !facts.isPlaying && uri === input.pausedPreviousUri)
          && !(changedPausedRestore && !facts.isPlaying))
          throw fail('TRACK_NOT_CURRENT');
        if (reuse) capturedObservation = saved;
        return facts;
      });
      // Native acquire/validate is awaited from this record's mutation queue. This narrow broker deliberately
      // observes the same record directly; enqueuing a normal readState here would deadlock its own proof.
      let facts = await observe();
      if (input.action === 'pause' && facts.isPlaying) {
        if (input.expectedSourceUri !== selectedUri || facts.disallows.pausing) throw fail('CONTROL_REJECTED');
        await (async () => {
          let timestampFloor = facts.serverTimestamp;
          // A recovery pause includes a prior GET and later confirmation reads.
          // Preserve the original two-second PUT limit inside that fixed total.
          const mutation = proofWindow(2000);
          invalidateObservation(record);
          const acknowledgment = await withinConfirmation(mutation,
            () => api.request('pause', proof, checkProof, { signal: mutation.signal }));
          const confirmation = proofWindow(8000);
          let previousPaused;
          for (;;) {
            facts = await observe(true, confirmation);
            const fresh = facts.serverTimestamp == null || timestampFloor == null || facts.serverTimestamp >= timestampFloor;
            if (facts.serverTimestamp != null && fresh) timestampFloor = facts.serverTimestamp;
            const paused = !facts.isPlaying && fresh;
            if (paused && (!pending(acknowledgment) || previousPaused?.positionMs === facts.positionMs)) { record.mutationPending = false; break; }
            previousPaused = paused ? facts : undefined;
            const remaining = confirmation.deadline - now(); if (remaining <= 0) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            await withinConfirmation(confirmation, () => wait(Math.min(settleIntervalMs, remaining), confirmation.signal));
          }
        })();
        record.onRouteParked?.();
      }
      if (input.requirePreparedSelection === true || reuse || restoring) {
        await preparationIntent.assertClear(); checkProof(); signal.throwIfAborted();
      }
      const preparationOwned = (input.requirePreparedSelection === true || reuse)
        && record.preparationLease?.selectedUri === selectedUri && record.routeEngaged === true
        && record.preparationPending !== true && !api.hasUnsettledWrites();
      const sourceWritesSettled = record.preparationPending !== true && record.mutationPending !== true && !api.hasUnsettledWrites();
      if ((input.requirePreparedSelection === true || reuse) && !preparationOwned) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      checkProof(); signal.throwIfAborted();
      if (reuse && (!capturedObservation || usableObservation(record, { allowExpired: heldPause || transfer }) !== capturedObservation
        || capturedObservation.lease !== record.preparationLease || record.preparationLease.generation !== input.generation
        || capturedObservation.preparationPhase !== input.preparationPhase)) throw fail('STALE_SESSION');
      const pcmStopped = readRoutePcmEvidence(record.sourceSession, input.generation) === true && sourceWritesSettled && !api.hasUnsettledWrites();
      if (restoring && (!pcmStopped || !capturedRestore || record.restoreObservation !== restoreContext
        || restoreContext.observation !== capturedRestore || restoreContext.invalidated
        || capturedRestore.mutationEpoch !== record.mutationEpoch || facts.observedAt > now()
        || now() - facts.observedAt >= OBSERVATION_MAX_AGE_MS)) throw fail('STALE_SESSION');
      const captureParkReceipt = seekEvidence();
      if (seekPark && (!captureParkReceipt || !sourceWritesSettled)) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      return { sourceDeviceId: facts.deviceId, trackUri: facts.trackId == null ? null : `spotify:track:${facts.trackId}`,
        isPlaying: facts.isPlaying, observedAtUtc: new Date(facts.observedAt).toISOString(),
        ...(facts.emptyPlayer ? { emptyPlayer: true } : {}),
        ...(transfer && !transferContext.isIntentCurrent() ? { pausedProofTransferSuperseded: true } : {}),
        pcmStopped, ...(seekPark ? { captureParkReceipt } : {}),
        ...(input.requirePreparedSelection === true || reuse ? { preparationOwned, playbackRequestPending: !sourceWritesSettled } : {}),
        ...(reuse ? { observationGeneration: capturedObservation.observationGeneration, mutationEpoch: capturedObservation.mutationEpoch,
          preparationPhase: capturedObservation.preparationPhase, positionMs: facts.positionMs } : {}),
        ...(restoring ? { restoreOperationId: restoreContext.operationId, observationGeneration: capturedRestore.observationGeneration,
          mutationEpoch: capturedRestore.mutationEpoch, positionMs: facts.positionMs, playbackRequestPending: !sourceWritesSettled } : {}) };
    },
    // Explicit position-only Play preserves the current Spotify context/queue.
    // Only a native-admitted pending same-track resume can use this method.
    async playAtPosition(session, pendingStart, { signal, beforeDispatch } = {}) {
      const record = get(session);
      let dispatched = false;
      return enqueue(record, async () => {
        const prepared = record.pendingPositionStart;
        const checkIntent = () => {
          own(record);
          if (!prepared || prepared.token !== pendingStart || !prepared.isIntentCurrent() || signal?.aborted)
            throw fail('CANCELLED');
        };
        checkIntent();
        const target = pendingStart.requestedPositionMs;
        if (!position(target, record.durationMs) || record.preparationPhase !== 'selected'
          || !record.routeEngaged || !record.preparationObservationOpen
          || prepared.observation.lease !== record.preparationLease
          || prepared.observation.lease?.generation !== record.routeProofGeneration) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        // The one-use 500ms handoff has already been consumed by native resume.
        // Keep the original receipt timestamp and ordinary 5s selected-state
        // validity during capture initialization; consumption never refreshes it.
        const observed = usableObservation(record);
        const before = observed?.lease === record.preparationLease ? observed.facts : await read(record);
        checkIntent();
        if (before.isPlaying || before.deviceId !== record.deviceId || before.trackId !== record.trackId
          || before.positionMs !== record.routePreparedParked?.positionMs) throw fail('PLAYBACK_STATE_UNCONFIRMED');
        if (before.disallows.resuming || before.disallows.seeking) throw fail('CONTROL_REJECTED');
        const confirmation = beginConfirmation(record, before);
        confirmation.overallSignal = AbortSignal.any([confirmation.overallSignal, ...(signal ? [signal] : [])]);
        confirmation.signal = AbortSignal.any([confirmation.signal, confirmation.overallSignal]);
        checkIntent();
        const acknowledgment = await withinConfirmation(confirmation, () => {
          checkIntent(); invalidateObservation(record);
          return api.request('play-at-position', record, checkIntent, { positionMs: target, signal: confirmation.signal,
            beforeDispatch: async () => {
              await beforeDispatch?.(); checkIntent();
              if (before.observedAt > now() || now() - before.observedAt >= OBSERVATION_MAX_AGE_MS)
                throw fail('PLAYBACK_STATE_UNCONFIRMED');
            }, onDispatch: () => { checkIntent(); dispatched = true; confirmation.commandAt = now(); } });
        });
        // An accepted response alone proves neither playing nor position. Always
        // require exact device/track and elapsed-time-plausible observed progress.
        const state = await confirmOperation(record, 'play', acknowledgment, true,
          { positionMs: target, confirmation, strictPair: false, strictPlaying: true });
        checkIntent(); record.preparationObservationOpen = false;
        return state;
      }, { preserveCancelled: () => !dispatched });
    },
    async play(session) { const record = get(session); return enqueue(record, async () => {
      if (record.pendingPositionStart) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      const state = await setPlaying(record, true, { reusePreparedObservation: record.preparationObservationOpen === true });
      record.preparationObservationOpen = false; return state;
    }); },
    async pause(session, { forPreparation = false, completedPause } = {}) { const record = get(session, { cleanup: true });
      return enqueue(record, async () => {
        record.pendingPositionStart = undefined;
        // One exact completed Pause may cross the immediately replacing reader.
        // Its real observation retains the original age, identity and mutation epoch.
        const reusable = record.completedPause; record.completedPause = undefined;
        if (forPreparation && completedPause && reusable?.state === completedPause
          && usableObservation(record) === reusable.observation && reusable.observation.lease === record.preparationLease
          && record.preparationPhase === 'selected' && record.routeEngaged === true
          && Number.isSafeInteger(record.preparationLease?.generation)
          && record.routeProofGeneration === record.preparationLease.generation) {
          record.pausedHoldObservation = reusable.observation;
          return reusable.observation.facts;
        }
        const previous = record.sourceObservation;
        record.pausedHoldObservation = undefined;
        const state = await setPlaying(record, false, { reusePreparedObservation: forPreparation && record.preparationObservationOpen === true });
        const observed = usableObservation(record);
        // Only this Pause's actual new GET may be consumed by the stopped-capture
        // hold transaction. Reusing an older prepared read creates no such permit.
        if (observed && observed !== previous && observed.preparationPhase === 'selected' && !observed.facts.isPlaying
          && observed.facts.trackId === record.trackId && observed.facts.deviceId === record.deviceId)
          record.pausedHoldObservation = observed;
        if (record.pausedHoldObservation === observed && observed)
          record.completedPause = { state, observation: observed };
        return state;
      }, { cleanup: true }); },
    terminalCleanupCheckpoint(session) {
      const record = get(session), observed = usableObservation(record), queue = mutation;
      if (!observed || observed.facts.isPlaying !== false || observed.facts.trackId !== record.trackId
        || observed.facts.deviceId !== record.deviceId || !record.routeEngaged
        || record.preparationPending || uncertainMutation || !mutationSettled) return null;
      // This is only an unchanged-controller fence for a completed terminal
      // cleanup. It grants no source observation, route proof or future Pause.
      return Object.freeze({ isCurrent: () => !closed && current === record && !record.revoked
        && !record.controller.signal.aborted && mutation === queue && mutationSettled && !uncertainMutation
        && !record.preparationPending && !record.mutationPending && !api.hasUnsettledWrites()
        && usableObservation(record, { allowExpired: true }) === observed });
    },
    beginPausedHoldProof(session) {
      const record = get(session, { cleanup: true }), observed = record.pausedHoldObservation;
      record.pausedHoldObservation = undefined;
      if (!observed || usableObservation(record) !== observed || observed.lease !== record.preparationLease
        || record.preparationPhase !== 'selected' || !Number.isSafeInteger(record.preparationLease?.generation)
        || record.routeProofGeneration !== record.preparationLease.generation || record.pausedHoldProof) return null;
      const proof = { observation: observed, generation: record.routeProofGeneration, invalidated: false };
      const cancellations = new Map();
      proof.bindSignal = signal => {
        if (!signal || cancellations.has(signal)) return;
        const abort = () => { proof.invalidated = true; };
        cancellations.set(signal, abort); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      };
      proof.isBound = () => record.pausedHoldProof === proof && !proof.invalidated && !closed
        && current === record && record.routeEngaged === true && usableObservation(record, { allowExpired: true }) === observed
        && record.routeProofGeneration === proof.generation && record.preparationLease === observed.lease;
      proof.isCurrent = () => proof.isBound() && !proof.fallback && usableObservation(record) === observed;
      record.pausedHoldProof = proof;
      return Object.freeze({ isCurrent: proof.isCurrent,
        acceptTransfer(id) {
          if (!proof.isCurrent() || !/^[a-f0-9-]{36}$/.test(id)
            || now() - observed.facts.observedAt >= TRANSFER_MAX_AGE_MS) return false;
          record.pausedResumeTransfer = { id, observation: observed }; return true;
        },
        close() { proof.invalidated = true; for (const [signal, abort] of cancellations) signal.removeEventListener('abort', abort);
          if (record.pausedHoldProof === proof) record.pausedHoldProof = undefined; } });
    },
    async seek(session, positionMs) {
      const record = get(session);
      if (!position(positionMs, record.durationMs)) return Promise.reject(fail('PROTOCOL_INVALID'));
      return enqueue(record, async () => {
        const before = await read(record);
        if (before.disallows.seeking) throw fail('CONTROL_REJECTED');
        const confirmation = beginConfirmation(record, before);
        const acknowledgment = await command('seek', record, confirmation, positionMs);
        return confirmOperation(record, 'seek', acknowledgment, before.isPlaying, { positionMs, confirmation,
          strictPair: false, strictPlaying: before.isPlaying && pending(acknowledgment) });
      });
    },
    close(session) { if (current?.session === session) revoke(current, 'CLOSED'); return Promise.resolve(); },
    clear() { revoke(current, 'CLOSED'); revision++; for (const record of observations) revoke(record, 'CLOSED'); return Promise.resolve(); },
    dispose() {
      closed = true;
      for (const record of routeSources.values()) record.routeProofController.abort();
      routeSources.clear(); return this.clear();
    },
  };
}

module.exports = { createDesktopPlaybackControl };
