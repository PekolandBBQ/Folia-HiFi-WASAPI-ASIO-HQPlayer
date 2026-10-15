'use strict';
const { performance } = require('node:perf_hooks');
const { setTimeout: waitForNative } = require('node:timers/promises');
const { isRetryableRouteCleanup } = require('./ownedRouteCleanup.cjs');
const { randomUUID } = require('node:crypto');
const { boundedJson } = require('./catalogObservation.cjs');
const { REQUIRED_DEVICE_SCOPE, REQUIRED_PLAYBACK_SCOPE } = require('./grantScopes.cjs');
const { reportSpotifyHttp, reportSpotifyPreparationFailure } = require('./requestDiagnostics.cjs');
const { RATE, FRAME_BYTES, QUEUE_BYTES, BOOTSTRAP_QUEUE_BYTES, sessionId, selectionFields, processBinding, requireConfiguration } = require('./cableCaptureProtocol.cjs');
const { fail, validTrack, position, sameStamp, metadataFacts, requireFacts, publicError, diagnosticCode } = require('./cableAudioFacts.cjs');
const { LIVE_PCM_TRANSPORT } = require('../nativeAudio/livePcmFormat.cjs');
const { createOwnedRouteAudio } = require('./ownedRouteAudio.cjs');
const { admitted } = require('./ownedRouteTrial.cjs');

// electron/spotify/cableAudioPreparation.cjs: official desktop control bound to a revocable, memory-only CABLE source.
function createCableAudioPreparation({ captureHost, control, vault, cooldown, getSelection, prefetchSelection, routeLifecycle, fetcher = fetch,
  media, officialMetadata, localSourceMetadata, onExternalSelection, now = Date.now, pollMs = 2000, cleanupTimeoutMs = 6000, onDiagnostic = () => {} } = {}) {
  if (!captureHost || !['inspectRoute', 'open'].every(key => typeof captureHost[key] === 'function')
    || !control || !['prepare', 'readState', 'play', 'pause', 'seek', 'close'].every(key => typeof control[key] === 'function')
    || !vault || !['token', 'stamp', 'grantedScopes'].every(key => typeof vault[key] === 'function')
    || !cooldown || !['load', 'defer'].every(key => typeof cooldown[key] === 'function')
    || officialMetadata != null && !['bind', 'get', 'remember', 'remove'].every(key => typeof officialMetadata[key] === 'function')
    || typeof getSelection !== 'function' || prefetchSelection != null && typeof prefetchSelection !== 'function' || typeof fetcher !== 'function' || typeof onDiagnostic !== 'function' || pollMs !== 2000
    || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 10000)
    throw publicError(fail('PROTOCOL_INVALID'));
  media ||= require('./soloistPcmProxy.cjs').createSoloistPcmProxy();
  const ownedAudio = routeLifecycle && createOwnedRouteAudio({ routeLifecycle, captureHost,
    beginPausedHoldProof: session => control.beginPausedHoldProof?.(session) });
  let current, revision = 0, disposed = false, providerOwner, leaving, preparationBarrier = Promise.resolve();
  const sourceUrls = new Set();
  function sourceUrlKey(value) {
    try {
      const url = new URL(value);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  }
  const jobs = new Map(), pending = new Set(), cleanupRecords = new Set();
  const metadataCache = new Map();
  let metadataStamp;
  function forgetMetadata(record, error) {
    // Normal reader cancellation preserves catalog facts; explicit cancel/revoke/clear still evict them.
    if (['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(error?.code)) return;
    if (officialMetadata) { if (record.metadataEntry) officialMetadata.remove(record.trackId, record.metadataEntry); return; }
    if (record.metadataEntry && metadataCache.get(record.trackId) === record.metadataEntry) metadataCache.delete(record.trackId);
  }
  function reportFailure(record, error) {
    // Control preparation can revoke this source before native capture is requested.
    // Its preparation/control diagnostics must not imply an attempted capture.
    if (record.read?.captureRequested !== true) return;
    if (record.failureReported) return;
    record.failureReported = true;
    try { onDiagnostic({ phase: 'failed', session: record.session, generation: record.read?.capture?.generation,
      errorCode: diagnosticCode(error) }); } catch { /* Diagnostics never change session cleanup. */ }
  }
  function track(task) { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); return task; }
  function own(record) {
    if (disposed || current !== record || record.revision !== revision) throw fail('CANCELLED');
    // A current source failure outlives the retired reader and remains visible to its replacement.
    if (record.failure && !['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) throw record.failure;
    if (record.releasing || record.controller.signal.aborted) throw fail('CANCELLED');
    if (record.stamp && !sameStamp(record.stamp, vault.stamp())) throw fail('SESSION_CHANGED');
  }
  function readOwned(record, read) {
    own(record);
    if (record.read !== read || record.intent !== read.intent || record.outputOwner !== read.owner || read.controller.signal.aborted)
      throw read.failure || fail('CANCELLED');
  }
  async function boundedCleanup(task) {
    let timer;
    try { await Promise.race([Promise.resolve(task).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  function cancelPlayingSeek(record) {
    const seek = record.playingSeek; record.playingSeek = null;
    if (!seek) return Promise.resolve();
    seek.cancelled = true;
    // This starts exact-generation full cleanup synchronously, before a queued
    // remote Pause or route proof. Expiry is only the abandoned-client fallback.
    const stopping = seek.retirement.cancel();
    void Promise.resolve(stopping).catch(() => {}); return stopping;
  }
  function invalidateRead(record, { retainCapture = false } = {}) {
    const read = record.read; record.read = null;
    if (!read) return;
    if (record.automaticRouting) record.retiredReads.add(read);
    read.routeAudio?.publicationStopped();
    clearTimeout(read.poll); read.detach?.(); read.controller.abort();
    if (read.capture && !retainCapture) void Promise.resolve(read.capture.stop()).catch(() => {});
  }
  function confirmRoutePaused(record) {
    record.preparationRoute?.confirmPaused();
    record.heldRoute?.confirmPaused();
    record.read?.routeAudio?.confirmPaused();
    for (const read of record.retiredReads) read.routeAudio?.confirmPaused();
  }
  function routedPreparation(record) {
    // A superseded track must finish its already-owned select/park transaction
    // before the next track enters. Reader cancellation does not abort route proof.
    const prepareOwned = () => {
      const owner = record.sourceOwner;
      if (!owner || owner !== providerOwner || owner.record !== record || owner.controller.signal.aborted
        || owner.failure) throw owner?.failure || fail('CANCELLED');
      if (!sameStamp(record.stamp, vault.stamp())) throw fail('SESSION_CHANGED');
    };
    return {
      beforeSelect: async paused => {
        prepareOwned();
        if (record.preparationRoute || paused.isPlaying !== false || paused.deviceId !== record.selection.deviceId)
          throw fail('PLAYBACK_STATE_UNCONFIRMED');
        const owner = record.sourceOwner;
        if (!owner || owner !== providerOwner || owner.failure) throw owner?.failure || fail('ROUTE_PROOF_UNCONFIRMED');
        if (owner.route) {
          record.preparationRoute = owner.route;
          await owner.route.rebindPreparation({ selectedTrackId: record.resolvedTrackId, pausedTrackId: paused.trackId,
            controlSession: record.session }); prepareOwned();
        } else {
          if (record.routeSourcePaused === false) await record.refreshRouteBinding(paused);
          prepareOwned();
          record.preparationRoute = owner.route = ownedAudio.create({ session: owner.session, controlSession: record.session,
            selection: record.selection, binding: record.routeBinding, pausedTrackId: paused.trackId,
            selectedTrackId: record.resolvedTrackId, signal: owner.controller.signal,
            onFailure: error => {
              owner.failure ||= error;
              const active = owner.record;
              if (active) void revokeSession(active.session, error.code).catch(() => {});
            } });
          try { await record.preparationRoute.prepareSelection(); prepareOwned(); }
          catch (error) {
            // Native explicitly refused before all writes: there is no lease to
            // suspend. Unknown acquisition outcomes still retain their owner.
            if (error?.noPolicyWrites === true) { record.preparationRoute = null; owner.route = null; }
            throw error;
          }
        }
      },
      afterSelect: async () => { prepareOwned(); await record.preparationRoute.verifyPreparedTargetActive(); prepareOwned(); },
      afterPark: async () => { prepareOwned(); await record.preparationRoute.completePreparation(); prepareOwned(); },
    };
  }
  async function holdRoutes(record) {
    const routes = new Set([record.heldRoute, record.preparationRoute,
      ...[...record.retiredReads].map(read => read.routeAudio)].filter(Boolean));
    if (routes.size > 1) throw fail('ROUTE_PROOF_UNCONFIRMED');
    for (const route of routes) {
      await route.suspendPaused();
      record.heldRoute = route;
    }
    record.preparationRoute = null;
    record.retiredReads.clear();
  }
  function terminalCleanupCompleted(record, terminal, intent, owner) {
    return terminal && terminal.intent === intent && terminal.owner === owner
      && !record.failure && !record.cleanupFailure && terminal.source.isCurrent()
      && record.sourceOwner === providerOwner && !providerOwner.failure
      && terminal.route === providerOwner.route && terminal.route.heldPaused === true
      && !record.read && !record.preparationRoute && !record.retiredReads.size;
  }
  // Retiring a track closes only its controller/PCM generation. The provider lease
  // and immutable native journal survive until an explicit provider exit or Quit.
  // Cleanup ownership is state, not an error-code allowlist. Failed attempts
  // keep the source controller and route; only in-flight work is shared.
  function release(record) {
    if (!record || record.sourceOwner?.released === true || record.sourceOwner?.route?.restored === true) return Promise.resolve();
    if (record.releasing) return record.releasing;
    const terminal = record.terminalCleanup, retiringIntent = record.intent, retiringOwner = record.outputOwner;
    record.terminalCleanup = null;
    cleanupRecords.add(record);
    const retry = !!record.cleanupFailure;
    let cleanupStage = 'cleanup-wait';
    if (retry) console.info('[SpotifyCleanup]', JSON.stringify({ stage: 'cleanup-retry', session: record.session,
      previousCode: diagnosticCode(record.cleanupFailure) }));
    void cancelPlayingSeek(record);
    record.releasing = Promise.resolve().then(async () => {
      if (record.automaticRouting) {
        await record.preparationPromise?.catch(() => {});
        await record.queue.catch(() => {});
      }
      let retainForRetry = false;
      try {
        if (record.sourceOwner?.record !== record && record.sourceOwner) return;
        const completed = record.externalSelection && record.heldRoute?.heldPaused === true
          || terminalCleanupCompleted(record, terminal, retiringIntent, retiringOwner);
        if (record.prepared && !completed) {
          if (record.automaticRouting) {
            cleanupStage = 'cleanup-source-pause';
            const paused = await control.pause(record.session);
            requireFacts(paused, record, false); confirmRoutePaused(record);
          } else await boundedCleanup(Promise.resolve().then(() => control.pause(record.session)));
        }
        if (record.automaticRouting && !completed) { cleanupStage = 'cleanup-route-hold'; await holdRoutes(record); }
        // A failed playback attempt is not a permanent provider failure once
        // native hold has confirmed the same lease paused with capture stopped.
        if (record.sourceOwner === providerOwner && providerOwner?.route?.heldPaused === true)
          providerOwner.failure = undefined;
        // The owner now retains the route alone. No late track/media callback may close it.
        record.preparationRoute = null; record.heldRoute = null; record.retiredReads.clear();
      } catch (error) {
        // Keep this controller and the exact route journal alive for a fresh
        // paused-hold attempt. Closing them here made every later click replay
        // the first failed Promise instead of recovering its session.
        retainForRetry = record.automaticRouting === true;
        error.stage ||= cleanupStage;
        throw error;
      } finally {
        if (!retainForRetry) {
          cleanupStage = 'cleanup-controller-close';
          await boundedCleanup(Promise.resolve().then(() => control.close(record.session)));
          record.controlController.abort();
          if (record.sourceOwner === providerOwner && !providerOwner?.route) {
            providerOwner?.controller.abort(); providerOwner = null;
          }
        }
      }
    });
    record.intent++; record.controller.abort(); invalidateRead(record);
    if (!record.prepared && !record.automaticRouting) record.controlController.abort();
    if (record.handle) void Promise.resolve(record.handle.revoke()).catch(() => {});
    const attempt = record.releasing;
    void attempt.then(() => {
      cleanupRecords.delete(record); record.cleanupFailure = undefined;
      if (retry) console.info('[SpotifyCleanup]', JSON.stringify({ stage: 'cleanup-recovered', session: record.session }));
    }, error => {
      record.cleanupFailure = error;
      if (record.sourceOwner) record.sourceOwner.failure ||= error;
      console.warn('[SpotifyCleanup]', JSON.stringify({ stage: 'cleanup-failed', session: record.session,
        nativeCode: error?.nativeCode || diagnosticCode(error), causeCode: error?.failureCode,
        retryable: record.automaticRouting === true, operation: cleanupStage,
        routeHeld: record.sourceOwner?.route?.heldPaused === true, controllerRetained: !record.controlController.signal.aborted }));
      if (record.releasing === attempt) record.releasing = null;
    });
    return record.releasing;
  }
  function revokeSession(session, code = 'CANCELLED') {
    const record = current;
    if (!record || record.session !== session) return Promise.resolve();
    forgetMetadata(record);
    if (!record.failure || ['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) record.failure = fail(code);
    if (!['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(code)) {
      if (record.sourceOwner) record.sourceOwner.failure ||= record.failure;
      reportFailure(record, record.failure);
    }
    if (record.read) record.read.failure = record.failure;
    return track(release(record));
  }
  function enqueue(record, guard, action) {
    const task = record.queue.catch(() => {}).then(async () => { own(record); guard(); return action(); });
    record.queue = task; return task;
  }
  function operationError(record, error) {
    forgetMetadata(record, error);
    if (!['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(error?.code) && current === record && !record.releasing)
      {
        if (!record.failure || ['CANCELLED', 'STALE_SESSION', 'SUPERSEDED', 'CLOSED'].includes(record.failure.code)) record.failure = error;
        if (record.sourceOwner) record.sourceOwner.failure ||= record.failure;
        reportFailure(record, record.failure); void track(release(record));
      }
    return publicError(error);
  }
  async function metadata(record, speculative = false) {
    // Explicit local-source seam: never fabricate an OAuth grant or an official track response.
    if (localSourceMetadata) {
      const facts = await localSourceMetadata(record.trackId, { signal: record.controller.signal }); own(record);
      if (facts?.trackId !== record.trackId || !Number.isSafeInteger(facts.durationMs)
        || facts.durationMs < 1 || facts.durationMs > 3600000) throw fail('METADATA_INVALID');
      record.stamp = { ...vault.stamp() };
      return Object.freeze({ trackId: facts.trackId, durationMs: facts.durationMs });
    }
    if (now() < await cooldown.load()) throw fail('RATE_LIMITED');
    own(record);
    const token = speculative ? await vault.token({ allowRefresh: false }) : await vault.token(); own(record);
    if (!token) throw fail(speculative ? 'PREPARATION_READ_DEFERRED' : 'AUTH_REQUIRED');
    record.stamp = { ...vault.stamp() };
    const receipt = officialMetadata?.bind();
    if (!officialMetadata) {
      if (!sameStamp(metadataStamp, record.stamp)) { metadataCache.clear(); metadataStamp = { ...record.stamp }; }
      const at = now();
      for (const [key, entry] of metadataCache) if (at < entry.observedAt || at - entry.observedAt >= 60000) metadataCache.delete(key);
    }
    const cached = officialMetadata ? officialMetadata.get(record.trackId, receipt) : metadataCache.get(record.trackId);
    if (cached) {
      own(record);
      if (speculative) return { facts: cached.facts, cached, receipt, observedAt: cached.observedAt };
      record.metadataEntry = cached; return cached.facts;
    }
    const httpStartedAt = performance.now();
    const response = await fetcher(`https://api.spotify.com/v1/tracks/${record.trackId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(12000)]),
    });
    // Monotonic fetch dispatch to headers; metadata/body validation remains outside this duration.
    const elapsedMs = Math.round(performance.now() - httpStartedAt);
    own(record); reportSpotifyHttp('playback-track', 'GET', response.status, undefined, undefined, undefined, elapsedMs);
    if (response.status === 429) { await cooldown.defer(response.headers.get('retry-after')); throw fail('RATE_LIMITED'); }
    if (response.status !== 200) throw fail(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'API_FORBIDDEN' : 'API_UNAVAILABLE');
    const raw = await boundedJson(response, () => own(record));
    const facts = Object.freeze(metadataFacts(raw, record.trackId));
    own(record);
    if (speculative) return { facts, raw, receipt, observedAt: now() };
    if (officialMetadata) {
      record.metadataEntry = officialMetadata.remember(raw, record.trackId, receipt);
      // Partial catalog objects can satisfy this request's historical validation,
      // but cannot create a private fallback that bypasses the shared eligibility gate.
      return facts;
    }
    // Cache only validated catalog identity/duration, under the original account and fixed one-minute lifetime.
    const entry = { facts, observedAt: now() };
    if (metadataCache.size >= 32) metadataCache.delete(metadataCache.keys().next().value);
    metadataCache.set(record.trackId, entry); record.metadataEntry = entry;
    return facts;
  }
  // Only the current track after prior retirement may publish speculative catalog facts.
  async function acceptMetadata(record, snapshot) {
    own(record);
    if (officialMetadata && !officialMetadata.isCurrent(snapshot.receipt)) throw fail('SESSION_CHANGED');
    if (snapshot.observedAt > now() || now() - snapshot.observedAt >= 60000) return metadata(record);
    if (snapshot.cached) {
      if (officialMetadata && officialMetadata.get(record.trackId, snapshot.receipt) !== snapshot.cached) return metadata(record);
      record.metadataEntry = snapshot.cached;
    } else if (officialMetadata) record.metadataEntry = officialMetadata.remember(snapshot.raw, record.trackId, snapshot.receipt,
      { observedAt: snapshot.observedAt });
    else {
      const entry = { facts: snapshot.facts, observedAt: snapshot.observedAt };
      if (metadataCache.size >= 32) metadataCache.delete(metadataCache.keys().next().value);
      metadataCache.set(record.trackId, entry); record.metadataEntry = entry;
    }
    return snapshot.facts;
  }
  // Attach both rejection observers immediately: cleanup can fail, or a newer
  // intent can cancel this request, before either read has produced a response.
  function beginPreparationReads(record) {
    const observe = (action, stage) => Promise.resolve().then(action)
      .then(value => ({ value, stage }), error => { throw { error, stage }; });
    const reads = observe(async () => {
      const scopes = await vault.grantedScopes(); own(record);
      if (!scopes.scopes?.includes(REQUIRED_DEVICE_SCOPE) || !scopes.scopes?.includes(REQUIRED_PLAYBACK_SCOPE)) throw fail('SCOPE_REQUIRED');
    }, 'scope').then(() => Promise.all([
      observe(() => metadata(record, true), 'track-metadata'),
      observe(() => prefetchSelection({ signal: record.controller.signal, session: record.session }), 'association'),
    ])).then(value => ({ value }), failure => failure);
    const signal = record.controller.signal;
    let abort;
    const cancelled = new Promise(resolve => {
      abort = () => resolve({ error: fail('CANCELLED'), stage: 'scope' });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    // A cancelled transport may still produce a late response. It remains
    // observed above, but cannot hold this source request or publish its facts.
    return Promise.race([reads, cancelled]).finally(() => signal.removeEventListener('abort', abort));
  }
  async function observeExternalSelection(record) {
    if(!onExternalSelection || !record?.prepared || !record.automaticRouting || record.releasing
      || record.externalTransition || record.playingSeek) return null;
    return enqueue(record,()=>own(record),async()=>{
      const changed=await control.observeExternalSelection(record.session,async()=>{
        record.externalTransition=true;record.intent++;invalidateRead(record);
      },async facts=>{
        const route=record.sourceOwner?.route;
        if(!route)throw fail('ROUTE_PROOF_UNCONFIRMED');
        await route.holdExternalSelection(facts.trackId);
        record.heldRoute=route;record.preparationRoute=null;record.retiredReads.clear();
        record.externalSelection=facts;
      });
      if(changed){
        record.externalTransition=false;
        onDiagnostic({phase:'external-track-held',session:record.session,previousTrackId:changed.previousTrackId,
          trackId:changed.trackId,positionMs:changed.positionMs});
        // Notify outside the control queue: releasing the output can itself ask to pause.
        void Promise.resolve().then(()=>onExternalSelection(changed)).catch(error=>{
          onDiagnostic({phase:'external-track-notification-failed',code:error?.code||'CONTROL_REJECTED'});
        });
      }
      return changed;
    });
  }
  function schedulePoll(record, read) {
    if (read.finishing) return;
    read.poll = setTimeout(() => { read.polling = (async () => {
      try {
        if (read.finishing) return;
        readOwned(record, read);
        if(onExternalSelection && await observeExternalSelection(record))return;
        const facts = await control.readState(record.session, { expectedPlaying: true }); readOwned(record, read); requireFacts(facts, record, true);
        if (read.finishing) return;
        if (read.capture.status) { await read.capture.status(); readOwned(record, read); }
        if (read.finishing) return;
        if (read.routeAudio) { await read.routeAudio.verifyActive(); readOwned(record, read); }
        schedulePoll(record, read);
      } catch (error) {
        if (record.read === read && !read.controller.signal.aborted) {
          read.failure = error; void revokeSession(record.session, error?.code || 'PLAYBACK_STATE_UNCONFIRMED');
        }
      }
    })(); }, pollMs);
    read.poll.unref?.();
  }
  // One owned startup promise supports lazy ordinary readers and a combined
  // request whose output clock waits for real confirmation before onFormat.
  function startReadable(record, read) {
    return read.starting ||= enqueue(record, () => readOwned(record, read), async () => {
      // Output creation can take seconds. Recheck the parked official identity
      // before opening capture; no native queue is started during that wait.
      let parked = await control.readState(record.session, { forPreparation: true, expectedPlaying: false }); readOwned(record, read); requireFacts(parked, record, false);
      if (parked.positionMs !== (read.pendingStart ? read.observedPausedPositionMs : read.positionMs)) throw fail('PLAYBACK_STATE_UNCONFIRMED');
      const onFailure = error => {
        if (record.read !== read) return;
        read.failure = error; read.failureAtIntent = record.intent;
        const cleanup = revokeSession(record.session, error?.code || 'CAPTURE_REQUEST_FAILED');
        // Release retires this reader synchronously. Keep that exact retirement
        // stamp so its own startup can report a fault, while a later intent or
        // consumer cannot inherit the old generation's failure.
        read.failureRetirementIntent = record.intent;
        void cleanup.catch(() => {});
      };
      if (record.automaticRouting) {
        if (!record.preparationRoute) throw fail('ROUTE_PROOF_UNCONFIRMED');
        read.routeAudio = record.preparationRoute; record.preparationRoute = null;
        read.captureRequested = true;
        await read.routeAudio.start({ signal: read.controller.signal, onFailure, positionIntentId: read.pendingStart?.resumeIntentId });
      } else read.captureRequested = true;
      const capture = read.routeAudio?.capture || await captureHost.open({ session: record.session, ...record.selection,
        signal: read.controller.signal, onFailure });
      read.capture = capture;
      try { readOwned(record, read); } catch (error) { void Promise.resolve(capture.stop()).catch(() => {}); throw error; }
      if (!read.routeAudio) await capture.start(); readOwned(record, read);
      const playing = read.pendingStart ? await control.playAtPosition(record.session, read.pendingStart, {
        signal: read.controller.signal,
        beforeDispatch: async () => {
          readOwned(record, read);
          if (typeof capture.beginPositionEpoch !== 'function') throw fail('CAPTURE_PROTOCOL_INVALID');
          const cut = await capture.beginPositionEpoch({ positionIntentId: read.pendingStart.resumeIntentId });
          readOwned(record, read);
          if (cut?.session !== (record.sourceOwner?.session || record.session) || cut.generation !== capture.generation
            || cut.positionIntentId !== read.pendingStart.resumeIntentId || !Number.isSafeInteger(cut.cutSequence) || cut.cutSequence < 1
            || cut.capturedFramesAtCut !== 0 || cut.deliveredFramesAtCut !== 0 || cut.queuedBytesAtCut !== 0
            || cut.startValidated !== true || cut.freshBuffer !== true || !Number.isSafeInteger(cut.stoppedAndResetAtUnixMs))
            throw fail('CAPTURE_PROTOCOL_INVALID');
          read.positionEpoch = cut;
        },
      }) : await control.play(record.session);
      readOwned(record, read); requireFacts(playing, record, true);
      let bufferedPrefix = 0;
      if (read.routeAudio) {
        // Both helpers inspect independently; promotion still writes only the private pipe.
        // Await both outcomes before cleanup so a late promotion cannot outlive a rejected proof.
        const startupChecks = await Promise.allSettled([read.routeAudio.verifyActive(), read.routeAudio.promote()]);
        readOwned(record, read);
        for (const result of startupChecks) if (result.status === 'rejected') throw result.reason;
        const promoted = startupChecks[1].value; bufferedPrefix = promoted.capturedFrames;
        // Native promotion opens only the private pipe. Recheck the retained isolation interval before
        // publishing its preserved prefix, including any event observed during proof-to-promotion.
        await read.routeAudio.verifyActive(); readOwned(record, read);
        if (typeof capture.beginPublication !== 'function') throw fail('CAPTURE_PROTOCOL_INVALID');
        bufferedPrefix = Math.max(bufferedPrefix, capture.beginPublication()); readOwned(record, read);
      }
      if (read.pendingStart) {
        if (!read.positionEpoch) throw fail('CAPTURE_PROTOCOL_INVALID');
        // This is a confirmed command-origin estimate, not an observed PCM frame
        // position. Preserve the real later GET checkpoint and time separately.
        read.positionMs = read.pendingStart.requestedPositionMs;
        read.positionOrigin = Object.freeze({ kind: 'confirmed-command-origin-estimate', positionMs: read.positionMs,
          observedPositionMs: playing.positionMs, observedAt: playing.observedAt });
        record.originMs = read.positionMs;
      }
      const prefixFrames = Math.max(capture.receivedFrames(), bufferedPrefix);
      if (!Number.isSafeInteger(prefixFrames) || prefixFrames < 0 || prefixFrames * FRAME_BYTES > (read.routeAudio ? BOOTSTRAP_QUEUE_BYTES : QUEUE_BYTES))
        throw fail('CAPTURE_PROTOCOL_INVALID');
      // Capture can start before Spotify emits this song. Keep that bounded
      // lead outside the remaining-song budget instead of truncating the tail.
      // The official position is an approximate observation, not sample timing.
      read.maximumBytes = (prefixFrames + Math.max(1, Math.ceil((record.durationMs - playing.positionMs) * RATE / 1000))) * FRAME_BYTES;
      // The host drains continuously into a bounded ring while this official
      // observation settles. Nothing is published before it confirms playing.
      schedulePoll(record, read);
    });
  }
  function readable(record, read) {
    return (async function* () {
      let complete = false;
      try {
        readOwned(record, read);
        await startReadable(record, read);
        const maximum = read.maximumBytes;
        read.routeAudio?.publicationStarted();
        read.playing = true;
        console.info('[SpotifyAudioRequest]', JSON.stringify({ phase: 'pcm-publication', trackId: record.trackId,
          requestId: record.requestId, session: record.session }));
        if (record.playingSeek?.newRead === read) record.playingSeek = null;
        let delivered = 0;
        for await (const block of read.capture.stream) {
          readOwned(record, read);
          if (!Buffer.isBuffer(block) || !block.length || block.length > 65536 || block.length % FRAME_BYTES) throw fail('CAPTURE_FRAME_INVALID');
          const accepted = Math.min(block.length, maximum - delivered);
          delivered += accepted;
          yield accepted === block.length ? block : Buffer.from(block.subarray(0, accepted));
          if (delivered === maximum) {
            // Returning the capture iterator stops its native keeper. Finish an
            // already dispatched active-route observation before that stop, so
            // normal EOF cannot poison the retained route with a stale check.
            read.finishing = true; clearTimeout(read.poll);
            await read.polling; readOwned(record, read); complete = true; break;
          }
        }
        if (!complete) throw fail('CAPTURE_PIPE_CLOSED');
      } catch (error) {
        const initial = read.failure || error;
        const capture = read.capture || read.routeAudio?.capture;
        // A pipe may close just before the same capture reports its native cause.
        // The host already stopped publication and started cleanup synchronously.
        const cause = capture?.resolveFailure ? await capture.resolveFailure(initial, read.outputSignal) : initial;
        throw operationError(record, cause);
      } finally {
        if (record.read === read) {
          invalidateRead(record);
          const intent = record.intent, owner = read.owner;
          // A completed or disconnected old consumer cannot pause a replacement.
          const guard = () => { if (record.intent !== intent || record.outputOwner !== owner) throw fail('CANCELLED'); };
          const cleanup = enqueue(record, guard, async () => {
            const paused = await control.pause(record.session); guard(); requireFacts(paused, record, false); confirmRoutePaused(record);
            await holdRoutes(record);
            return paused;
          }).catch(error => {
            const mapped = current === record && record.intent === intent && !record.releasing
              ? operationError(record, error) : publicError(error);
            if (complete) throw mapped;
          });
          // EOF admits the next track only after this exact PCM generation has
          // stopped and the Spotify provider route is safely held paused.
          if (complete) await cleanup;
        }
      }
    })();
  }
  function lookup(url) {
    const record = current;
    if (!record || record.handle?.url !== url || record.releasing || record.controller.signal.aborted) return null;
    const consumer = Symbol('cable-output-consumer'), serial = ++record.consumerSerial;
    let claimed = false, latestReader;
    function claim() {
      own(record);
      if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) throw fail('CANCELLED');
      record.outputOwner = consumer; record.outputSerial = serial; claimed = true;
    }
    function begin(signal) {
      if (signal?.aborted) throw fail('CANCELLED');
      claim(); record.terminalCleanup = null; record.terminalStop = null; const intent = ++record.intent; invalidateRead(record);
      const guard = () => {
        own(record);
        if (record.intent !== intent || record.outputOwner !== consumer || signal?.aborted) throw fail('CANCELLED');
      };
      return { intent, guard };
    }
    async function park({ positionMs } = {}, terminalStop) {
      if(record.externalTransition || record.externalSelection)return {positionMs:record.originMs};
      if (positionMs != null && !position(positionMs, record.durationMs) && positionMs !== record.durationMs) throw publicError(fail('INVALID_POSITION'));
      try {
        own(record);
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return;
        // Repeated Stop joins the same completed held owner without new commands.
        if (terminalStop && terminalCleanupCompleted(record, record.terminalCleanup, record.intent, consumer)) {
          if (positionMs != null) record.originMs = positionMs;
          return { positionMs: record.originMs };
        }
        void cancelPlayingSeek(record);
        const { guard, intent } = begin(); record.opened = true; record.preparedPendingStart = undefined;
        return await enqueue(record, guard, async () => {
          const paused = await control.pause(record.session); guard(); requireFacts(paused, record, false);
          confirmRoutePaused(record);
          await holdRoutes(record);
          if (terminalStop && record.automaticRouting) {
            const source = control.terminalCleanupCheckpoint?.(record.session);
            if (source?.isCurrent() && record.heldRoute?.heldPaused === true)
              record.terminalCleanup = { owner: consumer, intent, source, route: record.heldRoute };
          }
          guard();
          // The official producer can be seconds ahead of the speaker. Only the
          // output's heard checkpoint may advance the origin stored across Pause.
          const heardPosition = terminalStop?.positionMs ?? positionMs;
          if (heardPosition != null) record.originMs = heardPosition;
          return { positionMs: record.originMs };
        });
      } catch (error) { throw operationError(record, error); }
    }
    return {
      trackId: record.trackId, durationMs: record.durationMs, sampleRate: RATE, channels: 2, bitDepth: 32,
      assertReader(reader) {
        if (!reader || reader !== latestReader) throw fail('CANCELLED');
        reader.assertCurrent();
      },
      beginPlayingSeek({ positionMs } = {}) {
        own(record);
        const read = record.read;
        if (record.playingSeek) { void cancelPlayingSeek(record); return null; }
        if (!record.automaticRouting || !position(positionMs, record.durationMs) || !claimed
          || record.outputOwner !== consumer || read?.owner !== consumer || !read.playing
          || read.routeAudio?.supportsSeekPark !== true) return null;
        const transaction = randomUUID();
        const retirement = read.routeAudio.beginPlayingSeek(transaction);
        if (!retirement) return null;
        const seek = { owner: consumer, positionMs, transaction, retirement, route: read.routeAudio,
          intent: ++record.intent, cancelled: false, adopting: false };
        record.terminalCleanup = null; record.terminalStop = null; record.playingSeek = seek;
        invalidateRead(record, { retainCapture: true });
        return Object.freeze({ cancel: () => record.playingSeek === seek ? cancelPlayingSeek(record) : retirement.cancel() });
      },
      async seek(positionMs) {
        if (!position(positionMs, record.durationMs)) throw publicError(fail('INVALID_POSITION'));
        // A paused seek only updates the requested checkpoint. Positioning the
        // actual source belongs to the next fresh capture preparation.
        return park({ positionMs });
      },
      async openReadable({ positionMs = 0, signal } = {}) {
        if(record.externalTransition || record.externalSelection)throw publicError(fail('CANCELLED'));
        if (!position(positionMs, record.durationMs)) throw publicError(fail('INVALID_POSITION'));
        try {
          let playingSeek = record.playingSeek;
          if (playingSeek && (playingSeek.owner !== consumer || playingSeek.positionMs !== positionMs || playingSeek.adopting)) {
            void cancelPlayingSeek(record); playingSeek = null;
          }
          const { intent, guard } = begin(signal);
          if (playingSeek) {
            if (playingSeek.intent + 1 !== intent) { void cancelPlayingSeek(record); playingSeek = null; }
            else playingSeek.adopting = true;
          }
          return await enqueue(record, guard, async () => {
            let parked, combinedPositionAllowed = false;
            const preparedPending = record.preparedPendingStart;
            const initialPending = !record.opened && !record.retiredReads.size && record.preparationRoute
              && record.preparedPendingStart?.requestedPositionMs === positionMs ? record.preparedPendingStart : undefined;
            record.preparedPendingStart = undefined;
            if (initialPending) {
              record.positionPendingBinding = { owner: consumer, intent };
              combinedPositionAllowed = true;
              parked = await control.readState(record.session, { forPreparation: true }); guard(); requireFacts(parked, record, false);
              parked = { ...parked, pendingStart: initialPending };
            } else if (!record.automaticRouting || record.retiredReads.size || record.preparationRoute) {
              const completed = record.replacementPause; record.replacementPause = null;
              const completedPause = completed?.owner === consumer && completed.intent + 1 === intent ? completed.state : undefined;
              parked = await control.pause(record.session, { forPreparation: true, completedPause }); guard(); requireFacts(parked, record, false);
              confirmRoutePaused(record);
              // Replacing an active output keeps its exact same-track route, but
              // retires capture and its format holder before creating a new one.
              if (record.retiredReads.size || preparedPending && !initialPending) {
                if (playingSeek && record.playingSeek === playingSeek && !playingSeek.cancelled) {
                  await playingSeek.route.parkForSeek(); guard();
                  record.heldRoute = playingSeek.route; record.preparationRoute = null; record.retiredReads.clear();
                } else { await holdRoutes(record); guard(); }
              }
            }
            if (record.automaticRouting && record.heldRoute) {
              if (typeof control.resumeOwnedRoute !== 'function') throw fail('ROUTE_PROOF_UNCONFIRMED');
              const held = record.heldRoute;
              // Move ownership before the awaited resume so failure cleanup still
              // finds the lease even when native accepted only part of the command.
              record.preparationRoute = held; record.heldRoute = null;
              // A replaced reader cannot interrupt an already-owned source transaction.
              // Keep account, source, consumer and route ownership strict while its PUT
              // and native preparation settle; only PCM publication follows reader intent.
              const resumeOwned = () => {
                own(record);
                if (record.outputOwner !== consumer || record.preparationRoute !== held) throw fail('CANCELLED');
              };
              combinedPositionAllowed = typeof control.playAtPosition === 'function'
                && typeof captureHost.supportsPositionEpoch === 'function' && await captureHost.supportsPositionEpoch();
              guard();
              parked = await control.resumeOwnedRoute(record.session, { positionMs, deferPositionUntilPlay: combinedPositionAllowed,
                pausedProofTransferId: held.pausedProofTransferId, resumeIntentId: randomUUID(),
                isIntentCurrent: () => record.intent === intent && !signal?.aborted && record.outputOwner === consumer,
                beforePosition: async (_baseline, transfer) => { resumeOwned(); await held.resumePreparation(transfer); resumeOwned(); },
                afterPark: async () => { resumeOwned(); await held.completePreparation(); resumeOwned(); },
              });
              resumeOwned(); requireFacts(parked, record, false);
              if (!parked.pendingStart && Math.abs(parked.positionMs - positionMs) > 1000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
              if (record.intent !== intent || signal?.aborted) {
                confirmRoutePaused(record);
                await holdRoutes(record);
                throw fail('CANCELLED');
              }
              guard();
            } else if (record.automaticRouting && !record.preparationRoute) {
              if (typeof control.prepareOwnedRoute !== 'function') throw fail('ROUTE_PROOF_UNCONFIRMED');
              await record.refreshRouteBinding(); guard();
              combinedPositionAllowed = typeof control.playAtPosition === 'function'
                && typeof captureHost.supportsPositionEpoch === 'function' && await captureHost.supportsPositionEpoch(); guard();
              parked = await control.prepareOwnedRoute(record.session, { positionMs, ...routedPreparation(record),
                deferPositionUntilPlay: combinedPositionAllowed, positionStartIntentId: randomUUID(),
                isStartIntentCurrent: () => record.intent === intent && !signal?.aborted && record.outputOwner === consumer });
              guard(); requireFacts(parked, record, false);
              if (!parked.pendingStart && Math.abs(parked.positionMs - positionMs) > 1000) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            } else if (!initialPending && (record.opened || positionMs !== record.originMs || parked.positionMs !== record.originMs)) {
              parked = await control.seek(record.session, positionMs); guard(); requireFacts(parked, record, false);
            }
            if (parked.pendingStart && !combinedPositionAllowed) throw fail('PLAYBACK_STATE_UNCONFIRMED');
            if (!parked.pendingStart) record.originMs = parked.positionMs;
            record.opened = true;
            const read = { owner: consumer, intent, positionMs: parked.pendingStart ? undefined : parked.positionMs,
              pendingStart: parked.pendingStart, observedPausedPositionMs: parked.positionMs,
              outputSignal: signal, controller: new AbortController() };
            record.read = read;
            if (playingSeek && record.playingSeek === playingSeek) playingSeek.newRead = read;
            const abort = () => {
              if (record.read !== read) return;
              invalidateRead(record); const parkedIntent = ++record.intent;
              const parkedGuard = () => { if (record.intent !== parkedIntent || record.outputOwner !== consumer) throw fail('CANCELLED'); };
              void enqueue(record, parkedGuard, async () => {
                const paused = await control.pause(record.session); requireFacts(paused, record, false);
                // A replacement may supersede this reader during its dispatched Pause.
                // Hand the settled result only to the next intent of this same owner.
                if (record.outputOwner === consumer && record.intent === parkedIntent + 1)
                  record.replacementPause = { owner: consumer, intent: parkedIntent, state: paused };
                parkedGuard(); confirmRoutePaused(record); await holdRoutes(record);
              })
                .catch(error => { if (record.intent === parkedIntent && !record.releasing) operationError(record, error); });
            };
            signal?.addEventListener('abort', abort, { once: true }); read.detach = () => signal?.removeEventListener('abort', abort);
            if (signal?.aborted) { abort(); throw fail('CANCELLED'); }
            // The format is expected wire data. Actual capture snapshots remain lazy
            // and must validate before readable() can publish its first PCM frame.
            latestReader = Object.freeze({ stream: readable(record, read),
              get positionMs() { return read.positionMs; }, get positionOrigin() { return read.positionOrigin; },
              ...(read.pendingStart ? { async prepareOrigin() {
                try { readOwned(record, read); await startReadable(record, read); readOwned(record, read); return read.positionOrigin; }
                catch (error) {
                  const faultOwned = () => current === record && record.revision === revision
                    && record.outputOwner === read.owner && record.intent === read.failureRetirementIntent
                    && read.failureAtIntent === read.intent && !read.outputSignal?.aborted;
                  if (read.failure && faultOwned()) {
                    const capture = read.capture || read.routeAudio?.capture;
                    const cause = capture?.resolveFailure
                      ? await capture.resolveFailure(read.failure, read.outputSignal) : read.failure;
                    if (faultOwned()) throw operationError(record, cause);
                  }
                  throw operationError(record, error);
                }
              } } : {}),
              transport: Object.freeze({ ...LIVE_PCM_TRANSPORT }), assertCurrent: guard });
            return latestReader;
          });
        } catch (error) { throw operationError(record, error); }
      },
      pause: park,
      stop(options) {
        if (record.sourceOwner?.released === true || record.sourceOwner?.route?.restored === true) return Promise.resolve();
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return Promise.resolve();
        // Preserve the exact failed owner for a later authorized cleanup retry.
        // An aborted public reader must not turn its retained cleanup into success.
        if (record.releasing || record.controller.signal.aborted) return track(release(record));
        if (!record.automaticRouting) return park(options);
        if (options?.positionMs != null && !position(options.positionMs, record.durationMs) && options.positionMs !== record.durationMs)
          return Promise.reject(publicError(fail('INVALID_POSITION')));
        const pendingStop = record.terminalStop;
        if (pendingStop?.owner === consumer && pendingStop.intent === record.intent
          && !record.failure && sameStamp(record.stamp, vault.stamp())) {
          // Join the actual Pause/capture-stop/hold promise. It is not complete
          // until the first Stop settles, and every caller inherits its failures.
          if (options?.positionMs != null) pendingStop.positionMs = options.positionMs;
          return pendingStop.task;
        }
        const terminalStop = { owner: consumer, positionMs: options?.positionMs };
        const task = park(options, terminalStop);
        terminalStop.intent = record.intent; terminalStop.task = task; record.terminalStop = terminalStop;
        const settled = () => { if (record.terminalStop === terminalStop) record.terminalStop = null; };
        void task.then(settled, settled);
        return task;
      },
      revoke() {
        if (claimed && record.outputOwner !== consumer || record.outputSerial > serial) return Promise.resolve();
        if (current === record) forgetMetadata(record);
        return track(release(record));
      },
    };
  }
  async function run(id, requestId, onProgress = () => {}, quality = 'high') {
    // This is Folia's preference, not a command to change the Spotify client's encoding.
    const qualityValid = ['standard', 'high', 'lossless', 'hires'].includes(quality);
    const requestError = !validTrack(id) ? 'INVALID_AUDIO_TRACK_ID'
      : !sessionId(requestId) ? 'INVALID_AUDIO_REQUEST_ID' : !qualityValid ? 'INVALID_AUDIO_QUALITY' : null;
    if (requestError) {
      console.warn('[SpotifyAudioRequest]', JSON.stringify({ phase: 'rejected', nativeCode: requestError,
        requestedQuality: qualityValid ? quality : 'unknown', trackIdValid: validTrack(id), requestIdValid: sessionId(requestId) }));
      throw publicError(Object.assign(fail(requestError), { stage: 'request-validation' }));
    }
    console.info('[SpotifyAudioRequest]', JSON.stringify({ phase: 'accepted', trackId: id, requestId, requestedQuality: quality }));
    if (disposed || leaving || jobs.has(requestId)) throw publicError(fail('CANCELLED'));
    const previous = current;
    const record = { revision: ++revision, session: randomUUID(), requestId, trackId: id, controller: new AbortController(),
      controlController: new AbortController(), queue: Promise.resolve(), retiredReads: new Set(), intent: 0, consumerSerial: 0, outputSerial: 0 };
    const preceding = preparationBarrier;
    let finishPreparation;
    preparationBarrier = new Promise(resolve => { finishPreparation = resolve; });
    current = record; jobs.set(requestId, record);
    const retiring = release(previous);
    void retiring.catch(() => {});
    let stage = 'cleanup-previous-session';
    const reads = prefetchSelection && (!officialMetadata || typeof officialMetadata.isCurrent === 'function')
      ? beginPreparationReads(record) : null;
    try {
      await preceding;
      await retiring;
      // Failed retirement remains an ownership barrier; a new track never hides it.
      for (const retained of [...cleanupRecords]) await release(retained);
      stage = 'retained-provider-state';
      if (providerOwner?.failure) throw providerOwner.failure;
      own(record); onProgress({ stage: 'connect' });
      stage = 'scope';
      let facts, readPreparation;
      let result = reads ? await reads : null; own(record);
      // Restoration may outlast the token's no-refresh window even when both
      // GETs finished early. Recheck without refreshing before accepting them.
      if (result && !result.error && !await vault.token({ allowRefresh: false }))
        result = { error: fail('PREPARATION_READ_DEFERRED') };
      own(record);
      if (result?.error?.code === 'PREPARATION_READ_DEFERRED') {
        // No new source/route writes have occurred. After exact old capture retirement,
        // discard the read-only grant and reauthorize through the original path.
        record.stamp = undefined; result = null;
      }
      if (result) {
        stage = result.stage || 'scope';
        if (result.error) throw result.error;
        const [track, devices] = result.value;
        stage = 'track-metadata'; facts = await acceptMetadata(record, track.value); own(record);
        readPreparation = devices.value;
      } else {
        if (!localSourceMetadata) {
          const scopes = await vault.grantedScopes(); own(record);
          if (!scopes.scopes?.includes(REQUIRED_DEVICE_SCOPE) || !scopes.scopes?.includes(REQUIRED_PLAYBACK_SCOPE)) throw fail('SCOPE_REQUIRED');
        }
        stage = 'track-metadata'; facts = await metadata(record); own(record);
      }
      record.resolvedTrackId = facts.trackId; record.durationMs = facts.durationMs;
      stage = 'association';
      const selection = await getSelection({ signal: record.controller.signal, session: record.session, preparation: readPreparation }); own(record);
      if (typeof selection?.deviceId !== 'string' || !selection.deviceId || selection.deviceId.length > 256
        || /[\u0000-\u001f\u007f]/.test(selection.deviceId)) throw fail('DEVICE_NOT_SELECTED');
      record.selection = { deviceId: selection.deviceId, ...selectionFields(selection) };
      record.automaticRouting = selection.automaticRouting === true;
      if (record.automaticRouting && !ownedAudio) throw fail('ROUTE_HELPER_UNAVAILABLE');
      if (providerOwner && !record.automaticRouting) throw fail('ROUTE_PROOF_UNCONFIRMED');
      if (record.automaticRouting) {
        if (providerOwner) {
          if (!sameStamp(providerOwner.stamp, record.stamp)) throw fail('SESSION_CHANGED');
          if (['deviceId', 'captureDeviceId', 'renderDeviceId'].some(key => providerOwner.selection[key] !== record.selection[key]))
            throw fail('DEVICE_ID_MISMATCH');
        } else providerOwner = { session: randomUUID(), controller: new AbortController(),
          stamp: { ...record.stamp }, selection: { ...record.selection } };
        record.sourceOwner = providerOwner; providerOwner.record = record;
        const availability = await routeLifecycle.availability(); own(record);
        if (!admitted(availability)) throw fail(availability.code || 'ROUTE_HELPER_UNQUALIFIED');
        const bindObservedRoute = async facts => {
          own(record);
          const started = performance.now();
          let observation;
          do {
            observation = await routeLifecycle.inspect(record.selection); own(record);
            if (facts?.isPlaying !== false || observation.sourcePaused !== false) break;
            if (performance.now() - started >= 4000) throw fail('ROUTE_SOURCE_PAUSE_UNCONFIRMED');
            await waitForNative(60, undefined, { signal: record.controller.signal }); own(record);
          } while (true);
          record.routeBinding = observation.binding;
          record.routeSourcePaused = observation.sourcePaused;
          Object.assign(record.selection, { expectedSpotifyProcessId: record.routeBinding.expectedSpotifyProcessId,
            expectedSpotifyStartedAtUnixMs: record.routeBinding.expectedSpotifyStartedAtUnixMs });
        };
        record.refreshRouteBinding = bindObservedRoute;
        try { await bindObservedRoute(); }
        catch (error) {
          if (error?.code !== 'EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN') throw error;
          // Only this precise no-session result permits cold discovery at the current Spotify volume.
          // Ambiguous identity, unsafe policy, feedback and capability failures never start Spotify.
          record.needsColdBootstrap = true;
        }
      } else {
      let configuration = await captureHost.inspectRoute(record.selection); own(record);
      const binding = processBinding(configuration);
      if (configuration?.ready !== true && configuration?.temporaryFormatLeaseEligible === true
        && record.selection.temporaryFormatLease === true && typeof captureHost.formatProbe === 'function') {
        configuration = (await captureHost.formatProbe(record.selection)).configuration; own(record);
      }
      requireConfiguration(configuration, record.selection);
      const afterProbe = processBinding(configuration);
      if (binding.expectedSpotifyProcessId !== afterProbe.expectedSpotifyProcessId
        || binding.expectedSpotifyStartedAtUnixMs !== afterProbe.expectedSpotifyStartedAtUnixMs) throw fail('SPOTIFY_PROCESS_CHANGED');
      Object.assign(record.selection, binding);
      }
      stage = 'pcm-prepare';
      const combinedInitial = record.automaticRouting && typeof control.playAtPosition === 'function'
        && typeof captureHost.supportsPositionEpoch === 'function' && await captureHost.supportsPositionEpoch(); own(record);
      const preparation = control.prepare({ session: record.session, sourceSession: record.sourceOwner?.session || record.session, deviceId: record.selection.deviceId,
        trackId: record.resolvedTrackId, durationMs: record.durationMs, positionMs: 0, restoreSavedTarget: true,
        signal: record.controlController.signal, preparationDevices: selection.preparationDevices,
        ...(record.sourceOwner?.route ? { retainedSourceTrackId: record.sourceOwner.route.selectedTrackId }
          : record.refreshRouteBinding ? { coldBootstrap: record.refreshRouteBinding, coldBootstrapRequired: record.needsColdBootstrap === true } : {}),
        ...(record.automaticRouting ? {
          routedPreparation: routedPreparation(record), deferPositionUntilPlay: combinedInitial, positionStartIntentId: randomUUID(),
          isStartIntentCurrent: () => current === record && !record.controller.signal.aborted
            && (!record.positionPendingBinding || record.positionPendingBinding.intent === record.intent
              && record.positionPendingBinding.owner === record.outputOwner),
          onRouteParked: () => confirmRoutePaused(record),
        } : {}),
      });
      record.preparationPromise = preparation;
      const prepared = await preparation;
      if (localSourceMetadata) {
        // Local restored metadata can be rounded. Re-read after real selection;
        // accept only the duration also witnessed by the prepared playback state.
        const refreshed = await metadata(record); own(record);
        if (!require('./durationFacts.cjs').durationsAgree(refreshed.durationMs, prepared.durationMs))
          throw Object.assign(fail('PLAYBACK_STATE_UNCONFIRMED'), { stage: 'playback-facts', stateMismatch: 'duration-mismatch',
            expectedDurationMs: refreshed.durationMs, actualDurationMs: prepared.durationMs });
        // Keep the selected player's duration as the source/output boundary;
        // refreshing rounded catalog metadata must not shorten the live source.
        record.durationMs = prepared.durationMs;
      }
      record.prepared = true; own(record); requireFacts(prepared, record, false); record.originMs = prepared.positionMs;
      console.info('[SpotifyAudioRequest]', JSON.stringify({ phase: 'prepared', trackId: record.trackId,
        actualTrackId: prepared.trackId, requestId, session: record.session, positionMs: record.originMs }));
      record.preparedPendingStart = prepared.pendingStart;
      confirmRoutePaused(record);
      // Keep this exact route/journal through the first live reader; no restore/reacquire gap.
      own(record);
      stage = 'publish';
      record.handle = await media.add({
        async open({ signal }) { own(record); const source = lookup(record.handle.url); return (await source.openReadable({ positionMs: record.preparedPendingStart?.requestedPositionMs ?? record.originMs, signal })).stream; },
        close: () => release(record),
      });
      sourceUrls.add(sourceUrlKey(record.handle.url));
      // A cancelled add may finish after release already ran. Revoke its newly
      // returned URL immediately so no orphan media entry can outlive the source.
      if (record.releasing) void Promise.resolve(record.handle.revoke()).catch(() => {});
      own(record); onProgress({ stage: 'validate' });
      return { url: record.handle.url, fetchedAt: now(), requestedQuality: quality, quality: null, actualQuality: null,
        streaming: true, sessionBoundAudio: true, playbackTransport: 'cable-pcm', durationMs: record.durationMs,
        sourceInfo: { codec: null, container: null, encodingVerified: false, sampleRate: null, channels: null,
          bitDepth: null, bitrate: null, bitrateKind: null, lossless: null },
        preparedAudio: { codec: 'PCM', representation: 's32le', sampleFormat: 's32le', sampleRate: RATE, channels: 2, bitDepth: 32 },
        // Pending command intent has no observed PCM origin yet. The owned reader
        // exposes its typed estimate only after cut/Play/GET; no new IPC field is needed.
        ...(prepared.pendingStart ? {} : { pcmOriginMs: record.originMs }) };
    } catch (error) {
      const cancelled = record.controller.signal.aborted || current !== record || record.revision !== revision;
      forgetMetadata(record, error);
      if (!cancelled && record.sourceOwner?.route) record.sourceOwner.failure ||= error;
      if (['AUTH_REQUIRED', 'SESSION_CHANGED'].includes(error?.code)) metadataCache.clear();
      // Record the initiating stage before cleanup can fail and replace its public result.
      const failure = publicError(record.failure || (cancelled ? fail('CANCELLED') : error));
      failure.stage ||= stage;
      reportSpotifyPreparationFailure(requestId, stage, error, failure);
      try { await release(record); }
      catch (cleanupError) {
        reportSpotifyPreparationFailure(requestId, 'cleanup', error, cleanupError);
        throw publicError(record.failure || cleanupError);
      }
      if (current === record) current = null;
      // A failed source stays blocked under its retained provider owner. Keep
      // the initiating failure visible; only explicit exit may restore it.
      if (error?.code === 'ROUTE_SOURCE_PAUSE_UNCONFIRMED' && error.cause
        && (!record.failure || record.failure.code === error.code)) throw publicError(Object.assign(error.cause, { stage: error.stage || stage }));
      throw failure;
    } finally { if (jobs.get(requestId) === record) jobs.delete(requestId); finishPreparation(); }
  }
  return {
    observePausedExternalSelection:()=>current&&!current.read?observeExternalSelection(current):Promise.resolve(null),
    prepare(...args) { return track(run(...args)); }, lookup, revokeSession,
    cancel(requestId) { const record = jobs.get(requestId) || (current?.requestId === requestId ? current : null); if (record) { forgetMetadata(record); void track(release(record)); } },
    isSourceUrl(url) { return sourceUrls.has(sourceUrlKey(url)); },
    async invalidate(reason = 'SESSION_CHANGED') {
      metadataCache.clear(); metadataStamp = undefined;
      ++revision; const previous = current; current = null;
      if (providerOwner) providerOwner.failure ||= fail(reason);
      const results = await Promise.allSettled([...new Set([...jobs.values(), ...(previous ? [previous] : [])])].map(release));
      await preparationBarrier;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    leaveProvider(_reason = 'provider-exit', { verifyCaptureStop = false } = {}) {
      if (leaving) return leaving;
      leaving = Promise.resolve().then(async () => {
        metadataCache.clear(); metadataStamp = undefined;
        ++revision; const previous = current; current = null;
        const owner = providerOwner;
        const records = new Set([...cleanupRecords, ...jobs.values(), ...(previous ? [previous] : [])]);
        const results = await Promise.allSettled([...records].map(record => release(record)));
        await preparationBarrier;
        await Promise.allSettled([...pending]);
        // Native independently proves quiescence and exact originals, including
        // recovery after a failed local hold; only this receipt retires the owner.
        await owner?.route?.close();
        const released = owner && typeof routeLifecycle?.releaseRetained === 'function'
          ? await routeLifecycle.releaseRetained() : null;
        if (owner?.route && owner.route.restored !== true && released?.released !== true)
          throw fail('ROUTE_RESTORE_UNCONFIRMED');
        if (owner) owner.released = true;
        if (verifyCaptureStop) {
          await previous?.queue.catch(() => {});
          if (typeof captureHost.verifyStopped !== 'function') throw fail('CAPTURE_HELPER_EXIT_UNCONFIRMED');
          await captureHost.verifyStopped();
        }
        if ((providerOwner ?? null) !== (owner ?? null)) throw fail('ROUTE_PROOF_UNCONFIRMED');
        owner?.controller.abort(); providerOwner = null;
        for (const record of records) cleanupRecords.delete(record);
        const failed = results.find(result => result.status === 'rejected');
        if (failed && !owner?.route) throw failed.reason;
      });
      const task = leaving;
      void task.finally(() => { if (leaving === task) leaving = null; }).catch(() => {});
      return task;
    },
    clear(options) { return this.leaveProvider('clear', options); },
    async close() {
      disposed = true;
      try { await this.clear(); await media.close(); }
      catch (error) { if (isRetryableRouteCleanup(error)) disposed = false; throw error; }
    },
  };
}
module.exports = { createCableAudioPreparation };
