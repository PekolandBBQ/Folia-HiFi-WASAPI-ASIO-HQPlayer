'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createCablePcmQueue } = require('./cablePcmQueue.cjs');
const { RATE, QUEUE_BYTES, BOOTSTRAP_TIMEOUT_MS, BOOTSTRAP_QUEUE_BYTES, BOOTSTRAP_HOST_BYTES, BOOTSTRAP_CAPABILITY, START_PROOF_CAPABILITY, failure, sessionId, selectionFields, requireConfiguration, requireSnapshot, requireOwnedSilentRenderLease } = require('./cableCaptureProtocol.cjs');
const { projectEvent, projectConfigurationIssueCodes, projectFormatLeaseReadback } = require('../debug/privatePreviewDiagnosticSchema.cjs');

// electron/spotify/cableCaptureHost.cjs: hidden helper control and private generation-bound raw PCM pipes.
const MAX_REPLY_BYTES = 262144, MAX_REQUEST_BYTES = 32768, MAX_QUEUE = 16, MAX_CAPTURE_RECEIPTS = 16;
// Leave two native 32 KiB writes in the host ring before stopping pipe reads.
const PIPE_READ_RESERVE_BYTES = 65536;
const NATIVE_CAUSE_WAIT_MS = 250;
const PIPE_FAILURES = new Set(['CAPTURE_PIPE_CLOSED', 'CAPTURE_PIPE_FAILED']);
function createCableCaptureHost({ helperPath, platform = process.platform, spawnImpl = spawn,
  connectImpl = options => net.createConnection(options), requestTimeoutMs = 8000, pipeTimeoutMs = 8000, exitTimeoutMs = 2000,
  onDiagnostic = () => {}, onControlDiagnostic = () => {}, fastInitialEpoch = false, requireProcessCapture = false } = {}) {
  if (platform !== 'win32') throw failure('CAPTURE_UNSUPPORTED_PLATFORM');
  if (typeof helperPath !== 'string' || !helperPath.toLowerCase().endsWith('.exe')
    || !path.isAbsolute(helperPath) && !path.win32.isAbsolute(helperPath) || /[\u0000\r\n]/.test(helperPath)
    || typeof spawnImpl !== 'function' || typeof connectImpl !== 'function' || typeof onDiagnostic !== 'function'
    || typeof onControlDiagnostic !== 'function'
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15000
    || !Number.isInteger(pipeTimeoutMs) || pipeTimeoutMs < 1 || pipeTimeoutMs > 15000
    || !Number.isInteger(exitTimeoutMs) || exitTimeoutMs < 1 || exitTimeoutMs > 15000) throw failure('CAPTURE_PROTOCOL_INVALID');
  let processRecord, current, latestCapture, generation = 0, nextId = 0, closed = false, closing;
  function controlDiagnostic(phase, fields, configuration) {
    try {
      const event = projectEvent('spotify.capture-helper', { phase, processPlatform: platform, processArchitecture: process.arch, ...fields,
        ...(configuration !== undefined ? { configurationIssueCodes: projectConfigurationIssueCodes(configuration) } : {}) });
      if (event) onControlDiagnostic(event.fields);
    }
    catch { /* Observing helper commands never changes their results. */ }
  }
  function diagnostic(phase, record, errorCode) {
    const value = record?.state, config = value?.configuration;
    const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 42 ? n : undefined;
    try { onDiagnostic({ phase, session: record?.session, generation: record?.generation,
      ...(errorCode ? { errorCode: failure(errorCode).code } : {}),
      ...(value ? { snapshotSource: ['open', 'running', 'sample'].includes(phase) ? 'command-reply' : 'cached-command-reply',
      captureSampleRate: integer(value?.actualMixFormat?.sampleRate), captureChannels: integer(value?.actualMixFormat?.channels),
      captureBits: integer(value?.actualMixFormat?.containerBits), renderSampleRate: integer(config?.render?.mixFormat?.sampleRate),
      renderChannels: integer(config?.render?.mixFormat?.channels), renderBits: integer(config?.render?.mixFormat?.containerBits),
      capturedFrames: integer(value?.capturedFrames), deliveredFrames: integer(value?.deliveredFrames),
      queuedBytes: integer(value?.queuedBytes), queueCapacityBytes: integer(value?.queueCapacityBytes),
      initialDiscontinuity: value?.initialDiscontinuity === true, routeSpotifyOnly: config?.route?.spotifyOnlyObserved === true,
      formatLeaseApplied: config?.formatLease?.state === 'held' && config.formatLease.verified === true,
      formatLeaseReleased: value?.formatLeaseReleased === true } : {}),
    }); } catch { /* Diagnostics never control the producer. */ }
  }
  // A stop reply may be the only surviving native cause if cleanup beats the queued error event.
  // This is observational evidence only: it never changes stop acknowledgment or reopens publication.
  function terminalDiagnostic(receipt, value) {
    const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 42;
    if (!receipt || receipt.terminalObserved || value?.session !== receipt.session || value.generation !== receipt.generation
      || value.snapshotSource !== 'native-terminal' || !['failed', 'closed'].includes(value.state)
      || typeof value.cleanupConfirmed !== 'boolean'
      || value.state === 'failed' && typeof value.errorCode !== 'string'
      || value.state === 'closed' && value.errorCode != null
      || !count(value.capturedFrames) || !count(value.deliveredFrames)
      || !count(value.queuedBytes) || value.queuedBytes > BOOTSTRAP_HOST_BYTES) return;
    receipt.terminalObserved = true;
    // Refine a transport symptom only from this capture's validated native terminal.
    // Publication and cleanup have already stopped; this does not grant playback.
    const nativeCode = failure(value.errorCode).code;
    if (value.state === 'failed' && nativeCode !== 'CAPTURE_REQUEST_FAILED' && nativeCode !== 'CANCELLED'
      && !PIPE_FAILURES.has(nativeCode)) {
      receipt.failureCode = nativeCode;
    }
    receipt.resolveNativeCause?.();
    try {
      const readback = value.state === 'failed' && value.errorCode === 'FORMAT_LEASE_READBACK_MISMATCH'
        ? projectFormatLeaseReadback(value.formatLeaseReadback) : undefined;
      onDiagnostic({ phase: 'native-terminal', session: receipt.session, generation: receipt.generation,
      snapshotSource: 'native-terminal', captureState: value.state, cleanupConfirmed: value.cleanupConfirmed,
      ...(value.errorCode != null ? { errorCode: failure(value.errorCode).code } : {}),
      ...(readback ? { formatLeaseReadback: readback } : {}),
      ...(value.state === 'failed' && Number.isSafeInteger(value.hresult) && value.hresult >= -2147483648 && value.hresult <= 2147483647
        ? { hresult: value.hresult } : {}),
      ...(value.state === 'failed' && ['initialize', 'start', 'read', 'stop', 'pipe'].includes(value.failureStage)
        ? { failureStage: value.failureStage } : {}),
      concealedFrames: count(value.concealedFrames) ? value.concealedFrames : 0,
      discontinuities: count(value.discontinuities) ? value.discontinuities : 0,
      lastGapFrames: count(value.lastGapFrames) ? value.lastGapFrames : 0,
      capturedFrames: value.capturedFrames, deliveredFrames: value.deliveredFrames, queuedBytes: value.queuedBytes,
      ...(value.bootstrapMode === 'paused-source' ? { bootstrapMode: value.bootstrapMode } : {}),
      ...(['buffer', 'discard'].includes(value.bootstrapDelivery) ? { bootstrapDelivery: value.bootstrapDelivery } : {}),
      ...(['closed', 'buffering', 'discarding', 'live'].includes(value.deliveryState) ? { deliveryState: value.deliveryState } : {}),
    }); } catch { /* Native terminal evidence never controls cleanup. */ }
  }
  async function resolveFailure(record, error, signal) {
    if (signal?.aborted) return failure('CANCELLED');
    if (!PIPE_FAILURES.has(error?.code)) return error;
    const receipt = record.process?.captureReceipts.get(record.generation);
    if (!receipt || receipt.session !== record.session) return error;
    if (!receipt.failureCode && !receipt.terminalObserved) {
      // PCM EOF and native JSONL arrive independently. Never wait on helper exit
      // or its command timeout, and never delay the synchronous stop/revoke path.
      record.failureResolution ||= new Promise(resolve => {
        let timer;
        const finish = () => { clearTimeout(timer); receipt.resolveNativeCause = null; resolve(); };
        receipt.resolveNativeCause = finish; timer = setTimeout(finish, NATIVE_CAUSE_WAIT_MS);
      });
      let abort;
      const cancelled = new Promise(resolve => {
        abort = resolve; signal?.addEventListener('abort', abort, { once: true });
      });
      try { await Promise.race([record.failureResolution, cancelled]); }
      finally { signal?.removeEventListener('abort', abort); }
    }
    if (signal?.aborted) return failure('CANCELLED');
    return receipt.failureCode ? failure(receipt.failureCode) : error;
  }
  function own(record) {
    if (closed || current !== record || record.stopped || record.signal?.aborted) throw failure('CANCELLED');
  }
  function updatePipeFlow(record) {
    if (closed || current !== record || record.stopped || record.signal?.aborted || !record.socket) return;
    const available = record.queue.capacityBytes - record.queue.queuedBytes;
    if (!record.pipePaused && available < PIPE_READ_RESERVE_BYTES) {
      record.pipePaused = true; record.socket.pause?.();
    } else if (record.pipePaused && available >= PIPE_READ_RESERVE_BYTES * 2) {
      record.pipePaused = false; record.socket.resume?.();
    }
  }
  // Stop local publication synchronously. Exact native generation cleanup can settle later.
  function stop(record, code = 'CANCELLED', notify = false) {
    if (!record) return Promise.resolve();
    clearTimeout(record.seekTimer); record.seekCancelled = true;
    // A parked generation remains the native owner until adoption. Pause/Stop
    // must send its full stop even though local publication is already retired.
    if (current === record) current = null;
    if (!record.stopped) {
      record.stopped = true; clearTimeout(record.bootstrapTimer); record.queue.cancel(code);
      // Let native cancellation close its writer before an intentional reader close.
      // Keep draining a paused pipe while the control command is queued; the stopped
      // data handler discards these bytes and can never reopen PCM publication.
      record.closePipeAfterStop = code === 'CANCELLED' && !notify && record.nativeOpened && !record.process?.dead;
      if (record.closePipeAfterStop) { record.pipePaused = false; record.socket?.resume?.(); }
      else record.socket?.destroy();
      record.detach?.();
      if (current === record) current = null;
      diagnostic(notify ? 'failed' : 'stopped', record, notify ? code : undefined);
      if (notify) { try { Promise.resolve(record.onFailure?.(failure(code))).catch(() => {}); } catch {} }
    }
    if (record.nativeOpened && !record.stopSent) {
      record.stopSent = true;
      record.stopping = command(record.process, { action: 'capture-stop', session: record.session, generation: record.generation })
        .then(value => {
          if (value.state !== 'closed' || value.session !== record.session || value.generation !== record.generation) {
            breakProcess(record.process, 'CAPTURE_PROTOCOL_INVALID'); return;
          }
          terminalDiagnostic(record.process.captureReceipts.get(record.generation), value.terminalEvidence);
          record.stopVerified = true;
          if (record.state?.configuration?.formatLease?.state === 'held') {
            record.state = { ...record.state, formatLeaseReleased: true }; diagnostic('stopped', record);
          }
        }).finally(() => { if (record.closePipeAfterStop) record.socket?.destroy(); }).catch(() => {});
    }
    return record.stopping || Promise.resolve();
  }
  function beginSeekRetirement(record, seekTransaction) {
    own(record);
    if (!record.process?.seekReuseCapable
      || !record.published || !record.promoted || !record.starting || record.seekRetirement
      || !sessionId(seekTransaction)) return null;
    record.stopped = true;
    clearTimeout(record.bootstrapTimer); record.queue.cancel(); record.detach?.();
    // Continue draining only the retired pipe while the already-requested
    // source Pause settles. Native sampling stops at the explicit park ACK.
    record.socket?.resume?.(); record.pipePaused = false;
    record.seekTimer = setTimeout(() => { void stop(record); }, 5000); record.seekTimer.unref?.();
    const retirement = Object.freeze({
      session: record.session, generation: record.generation, seekTransaction,
      cancel: () => stop(record),
      async park() {
        if (record.seekCancelled || current !== record || record.stopSent) throw failure('CANCELLED');
        if (!record.parking) record.parking = command(record.process, { action: 'capture-seek-park',
          session: record.session, generation: record.generation, seekTransaction, sameTrackPlayingSeek: true }).then(value => {
          const boundary = value?.resetBoundary;
          if (value?.state !== 'seek-parked' || value.session !== record.session || value.generation !== record.generation
            || value.seekTransaction !== seekTransaction || !sessionId(value.seekToken) || value.expiresInMs !== 5000
            || value.captureStopped !== true || value.captureReset !== true || value.oldGenerationRetired !== true
            || value.retainedInitialized !== true || value.formatLeaseReleased !== false
            || boundary?.previousSession !== record.session || boundary.previousGeneration !== record.generation
            || !Number.isSafeInteger(boundary.resetSequence) || boundary.resetSequence < 1
            || !Number.isSafeInteger(boundary.stoppedAndResetAtUnixMs) || boundary.stoppedAndResetAtUnixMs <= 0)
            throw failure('CAPTURE_PROTOCOL_INVALID');
          if (record.seekCancelled || current !== record || record.stopSent) throw failure('CANCELLED');
          record.seekParkReceipt = Object.freeze({ ...value, resetBoundary: Object.freeze({ ...boundary }) });
          clearTimeout(record.seekTimer);
          record.seekTimer = setTimeout(() => { void stop(record); }, value.expiresInMs); record.seekTimer.unref?.();
          record.socket?.destroy(); return record.seekParkReceipt;
        }).catch(async error => { await stop(record); throw error; });
        return record.parking;
      },
    });
    record.seekRetirement = retirement; return retirement;
  }
  // Keep an unconfirmed child owned, even after its command channel has failed.
  // Dispatching kill (including child.killed) is not evidence of process exit.
  function terminate(record) {
    if (record.exiting) return record.exiting;
    if (record.exited) return record.exiting = Promise.resolve(null);
    let settle;
    record.exiting = new Promise(resolve => { settle = resolve; });
    const timer = setTimeout(() => {
      const error = failure('CAPTURE_HELPER_EXIT_UNCONFIRMED');
      controlDiagnostic('failed', { operation: 'close', ok: false, errorCode: error.code });
      settle(error);
    }, exitTimeoutMs);
    record.finishExit = () => { clearTimeout(timer); settle(null); };
    try { record.child?.stdin?.destroy(); } catch {}
    if (!record.exited) { try { record.child?.kill(); } catch {} }
    return record.exiting;
  }
  async function requireExit(record) {
    const error = await terminate(record);
    if (error) throw error;
  }
  function breakProcess(record, code) {
    if (!record || record.dead) return;
    if (!closed) controlDiagnostic('failed', { operation: record.active?.operation, ok: false, errorCode: failure(code).code });
    record.dead = true; clearTimeout(record.active?.timer);
    const pending = [record.active, ...record.queue]; record.active = null; record.queue.length = 0;
    for (const item of pending) item?.reject(failure(code));
    if (current?.process === record) void stop(current, code, true);
    else if (!closed) diagnostic('failed', null, code);
    void terminate(record);
  }
  function pump(record) {
    if (record.dead || record.active || !record.queue.length) return;
    const item = record.queue.shift(); record.active = item;
    item.timer = setTimeout(() => breakProcess(record, 'CAPTURE_CONTROL_TIMEOUT'), requestTimeoutMs);
    try { record.child.stdin.write(item.line, error => { if (error) breakProcess(record, 'CAPTURE_HELPER_UNAVAILABLE'); }); }
    catch { breakProcess(record, 'CAPTURE_HELPER_UNAVAILABLE'); }
  }
  function command(record, input) {
    if (!record || record.dead) return Promise.reject(failure('CAPTURE_HELPER_CLOSED'));
    if (record.queue.length + (record.active ? 1 : 0) >= MAX_QUEUE) return Promise.reject(failure('CAPTURE_CONTROL_BUSY'));
    if (nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(failure('HELPER_RESTART_REQUIRED'));
    const id = ++nextId, line = JSON.stringify({ ...input, id }) + '\n';
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return Promise.reject(failure('CAPTURE_PROTOCOL_INVALID'));
    return new Promise((resolve, reject) => { record.queue.push({ id, line, operation: input.action, session: input.session, generation: input.generation, resolve, reject }); pump(record); });
  }
  function receive(record, bytes) {
    if (record.dead) return;
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_REPLY_BYTES || record.buffer.length + bytes.length > MAX_REPLY_BYTES) {
      breakProcess(record, 'CAPTURE_PROTOCOL_INVALID'); return;
    }
    record.buffer = Buffer.concat([record.buffer, bytes]);
    for (;;) {
      const end = record.buffer.indexOf(10); if (end < 0) return;
      const line = record.buffer.subarray(0, end); record.buffer = record.buffer.subarray(end + 1);
      let value;
      try { value = JSON.parse(line.toString('utf8')); } catch { breakProcess(record, 'CAPTURE_PROTOCOL_INVALID'); return; }
      if (value?.event === 'capture-error') {
        // PCM EOF can arrive before the native control event. Preserve only bounded,
        // exact-generation evidence; a retired source can never stop its replacement.
        const receipt = record.captureReceipts.get(value.generation);
        if (receipt?.session === value.session && !receipt.nativeFailureObserved) {
          receipt.nativeFailureObserved = true;
          diagnostic('native-failed', receipt, failure(value.errorCode).code);
        }
        if (receipt?.session === value.session) terminalDiagnostic(receipt, value.terminalEvidence);
        const source = current;
        if (source?.process === record && source.session === value.session && source.generation === value.generation)
          void stop(source, failure(value.errorCode).code, true);
        continue;
      }
      const item = record.active;
      if (!item || value?.id !== item.id || typeof value.ok !== 'boolean'
        || value.ok && (!value.result || typeof value.result !== 'object' || Array.isArray(value.result))) {
        breakProcess(record, 'CAPTURE_PROTOCOL_INVALID'); return;
      }
      clearTimeout(item.timer); record.active = null;
      if (item.operation !== 'hello' && (item.operation !== 'status' || !value.ok)) {
        // A valid protocol reply can still reject native format negotiation. Keep its
        // bounded failure evidence without changing command resolution or playback gates.
        const configurationFailure = value.ok && ['format-probe', 'capture-open'].includes(item.operation)
          && value.result.state === 'configuration-required';
        const source = configurationFailure ? value.result : value;
        const hresult = Number.isInteger(source.hresult) && source.hresult >= -2147483648 && source.hresult <= 4294967295
          ? source.hresult : undefined;
        const ok = value.ok && !configurationFailure;
        const configuration = value.ok && (item.operation === 'inspect-route' ? value.result
          : ['format-probe', 'capture-open'].includes(item.operation) ? value.result.configuration : undefined);
        controlDiagnostic('result', { operation: item.operation, ok,
          ...(!ok ? { errorCode: failure(source.errorCode ?? (configurationFailure ? 'CAPTURE_CONFIGURATION_REQUIRED' : undefined)).code,
            hresult, formatLeaseReadback: projectFormatLeaseReadback(source.formatLeaseReadback) } : {}) }, configuration);
      }
      if (value.ok) item.resolve(value.result);
      else {
        const error = failure(value.errorCode, value);
        // A failed unpublished position cut can close its pipe before its JSONL
        // rejection arrives. Retain only this exact command's native cause; a
        // retired generation cannot change the active generation's receipt.
        const receipt = item.operation === 'capture-begin-position-epoch' && record.captureReceipts.get(item.generation);
        if (receipt?.session === item.session && error.code === 'HELPER_RESTART_REQUIRED') {
          receipt.failureCode ||= error.code; receipt.resolveNativeCause?.();
        }
        item.reject(error);
        if (['HELPER_RESTART_REQUIRED', 'CAPTURE_STOP_TIMEOUT'].includes(error.code)) { breakProcess(record, error.code); return; }
      }
      pump(record);
    }
  }
  async function ensure() {
    if (closed) throw failure('CAPTURE_HELPER_CLOSED');
    if (processRecord?.dead) {
      await requireExit(processRecord);
      return ensure();
    }
    let record = processRecord;
    if (!record) {
      let child;
      try { child = spawnImpl(helperPath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch {
        controlDiagnostic('failed', { operation: 'hello', ok: false, errorCode: 'CAPTURE_HELPER_UNAVAILABLE' });
        throw failure('CAPTURE_HELPER_UNAVAILABLE');
      }
      record = { child, queue: [], active: null, dead: false, exited: false, buffer: Buffer.alloc(0), ready: null, captureReceipts: new Map() };
      processRecord = record;
      // Subscribe before validation or any path that can request termination.
      if (typeof child?.on === 'function') child.on('exit', () => {
        record.exited = true; record.finishExit?.();
        if (processRecord === record) processRecord = null;
        breakProcess(record, 'CAPTURE_HELPER_CLOSED');
      });
      if (!child?.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
        breakProcess(record, 'CAPTURE_HELPER_UNAVAILABLE'); throw failure('CAPTURE_HELPER_UNAVAILABLE');
      }
      child.on('error', () => breakProcess(record, 'CAPTURE_HELPER_UNAVAILABLE'));
      child.stdin.on('error', () => breakProcess(record, 'CAPTURE_HELPER_UNAVAILABLE'));
      child.stdout.on('data', bytes => receive(record, bytes));
      child.stdout.on('error', () => breakProcess(record, 'CAPTURE_PROTOCOL_INVALID'));
      child.stdout.on('end', () => breakProcess(record, 'CAPTURE_HELPER_CLOSED'));
      // Drain stderr without retaining or exposing arbitrary helper output.
      child.stderr.on('data', () => {}); child.stderr.on('error', () => {});
      record.ready = command(record, { action: 'hello', protocolMajor: 1 }).then(value => {
        const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
        const helloCompatible = value.protocolMajor === 1 && value.platform === 'win32-x64' && value.sampleRate === RATE
          && value.channels === 2 && value.bitDepth === 32 && value.sampleFormat === 's32le' && value.queueCapacityBytes === QUEUE_BYTES
          && ['base-vb-cable-capture-v1', 's32le-pipe-v1', 'route-process-observation-v1', START_PROOF_CAPABILITY].every(name => capabilities.includes(name))
          && (!requireProcessCapture || capabilities.includes('windows-process-tree-loopback-v1'));
        controlDiagnostic('hello', { operation: 'hello', protocolMajor: value.protocolMajor, helperPlatform: value.platform,
          helloCompatible, baseCableCapability: capabilities.includes('base-vb-cable-capture-v1'),
          pcmPipeCapability: capabilities.includes('s32le-pipe-v1'), routeObservationCapability: capabilities.includes('route-process-observation-v1'),
          temporaryFormatLeaseCapability: capabilities.includes('temporary-format-lease-v1'),
          ...(!helloCompatible ? { errorCode: 'CAPTURE_PROTOCOL_INVALID' } : {}) });
        if (!helloCompatible) throw failure('CAPTURE_PROTOCOL_INVALID');
        record.capabilities = value.capabilities;
        record.seekReuseCapable = value.componentVersion === '0.1.5-capture.7' && capabilities.includes('bounded-playing-seek-device-reuse-v1');
        record.positionEpochCapable = value.componentVersion === '0.1.5-capture.7' && capabilities.includes('unpublished-position-epoch-v1');
        record.boundedBootstrap = capabilities.includes(BOOTSTRAP_CAPABILITY)
          && value.bootstrapTimeoutMs === BOOTSTRAP_TIMEOUT_MS && value.bootstrapQueueCapacityBytes === BOOTSTRAP_QUEUE_BYTES;
        return record;
      }).catch(error => { breakProcess(record, failure(error?.code).code); throw failure(error?.code); });
    }
    return record.ready;
  }
  async function connect(record) {
    own(record);
    let socket;
    try { socket = connectImpl({ path: '\\\\.\\pipe\\' + record.pipeName, readableHighWaterMark: 32768 }); }
    catch { throw failure('CAPTURE_PIPE_FAILED'); }
    record.socket = socket;
    if (!socket || typeof socket.on !== 'function' || typeof socket.destroy !== 'function') throw failure('CAPTURE_PIPE_FAILED');
    socket.on('data', bytes => {
      if (record.stopped) return;
      if (record.selection.bootstrapMode === 'paused-source' && !record.promoted && !record.promoting) {
        void stop(record, 'CAPTURE_PROTOCOL_INVALID', true); return;
      }
      record.queue.push(bytes);
      updatePipeFlow(record);
    });
    socket.on('error', () => { if (!record.stopped) void stop(record, 'CAPTURE_PIPE_FAILED', true); });
    socket.on('end', () => { if (!record.stopped) record.queue.end(); });
    socket.on('close', () => { if (!record.stopped) record.queue.end(); });
    await new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer); socket.removeListener('connect', connected); socket.removeListener('error', failed);
        socket.removeListener('close', failed); record.signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const connected = () => done(), failed = () => done(failure('CAPTURE_PIPE_FAILED')), aborted = () => done(failure('CANCELLED'));
      const timer = setTimeout(() => done(failure('CAPTURE_PIPE_TIMEOUT')), pipeTimeoutMs);
      socket.once('connect', connected); socket.once('error', failed); socket.once('close', failed);
      record.signal?.addEventListener('abort', aborted, { once: true });
      if (record.signal?.aborted || record.stopped) aborted();
    });
    own(record);
  }
  return {
    async supportsPositionEpoch() {
      const record = await ensure();
      return record.positionEpochCapable;
    },
    async devices() {
      const value = await command(await ensure(), { action: 'devices' });
      if (Array.isArray(value.endpoints) && value.endpoints.length <= 256) {
        const capture = value.endpoints.filter(endpoint => endpoint?.supportedBaseCable === true && endpoint.flow === 'capture');
        const render = value.endpoints.filter(endpoint => endpoint?.supportedBaseCable === true && endpoint.flow === 'render');
        const oneCapture = capture.length === 1 ? capture[0].mixFormat : undefined;
        const oneRender = render.length === 1 ? render[0].mixFormat : undefined;
        const endpoint = value.endpointInventory, control = value.controlInterface;
        controlDiagnostic('inventory', { operation: 'devices', captureEndpointCount: capture.length, renderEndpointCount: render.length,
          endpointInventoryState: endpoint?.state, endpointActiveCount: endpoint?.activeCount,
          endpointDisabledCount: endpoint?.disabledCount, endpointNotPresentCount: endpoint?.notPresentCount,
          endpointUnpluggedCount: endpoint?.unpluggedCount, endpointUnreadableCount: endpoint?.unreadableCount,
          endpointHresult: endpoint?.hresult, controlInterfaceState: control?.state,
          controlInterfaceCount: control?.interfaceCount, controlInterfaceActiveCount: control?.activeInterfaceCount,
          controlInterfaceWin32Error: control?.win32Error, controlInterfaceFailureStage: control?.failureStage,
          singleCaptureMixSampleRate: oneCapture?.sampleRate, singleCaptureChannels: oneCapture?.channels,
          singleCaptureBits: oneCapture?.containerBits, singleRenderMixSampleRate: oneRender?.sampleRate,
          singleRenderChannels: oneRender?.channels, singleRenderBits: oneRender?.containerBits });
      }
      return value;
    },
    async inspectRoute(selection) { const fields = selectionFields(selection); return command(await ensure(), { action: 'inspect-route', ...fields }); },
    async formatProbe(selection) {
      const fields = selectionFields(selection);
      if (fields.temporaryFormatLease !== true) throw failure('CAPTURE_CONFIGURATION_REQUIRED');
      const process = await ensure();
      if (!process.capabilities.includes('temporary-format-lease-v1')) throw failure('FORMAT_LEASE_UNSUPPORTED');
      const value = await command(process, { action: 'format-probe', ...fields });
      if (value?.state === 'configuration-required') throw failure(value.errorCode || 'CAPTURE_CONFIGURATION_REQUIRED', value);
      if (value?.state !== 'released' || value.verified !== true || value.formatLease?.state !== 'released'
        || value.formatLease.verified !== true || value.formatLease.persistentSettingsChanged !== false
        || value.configuration?.formatLease?.state !== 'released') throw failure('CAPTURE_PROTOCOL_INVALID');
      requireConfiguration(value.configuration, fields); return value;
    },
    async open({ session, signal, onFailure, seekReuse, ...input } = {}) {
      if (!sessionId(session)) throw failure('CAPTURE_PROTOCOL_INVALID');
      const selection = selectionFields(input);
      if (closed || signal?.aborted) throw failure('CANCELLED');
      const previous = current;
      if (seekReuse && (previous?.seekRetirement !== seekReuse || !previous.seekParkReceipt
        || previous.seekCancelled || previous.stopSent || previous.session !== session)) throw failure('CANCELLED');
      const record = { session, generation: ++generation, selection, signal, onFailure,
        pipeName: 'folia-capture-' + randomBytes(16).toString('hex'), stopped: false, nativeOpened: false };
      latestCapture = record;
      record.bufferedBootstrap = selection.bootstrapMode === 'paused-source' && selection.bootstrapDelivery === 'buffer';
      record.queue = createCablePcmQueue({ bufferedBootstrap: record.bufferedBootstrap,
        // Resume after the pending queue read has settled, never reenter push/read.
        onDrain: () => queueMicrotask(() => updatePipeFlow(record)),
        onFailure: error => { void stop(record, error.code, error.code !== 'CANCELLED'); } });
      current = record;
      const abort = () => { void stop(record); };
      signal?.addEventListener('abort', abort, { once: true }); record.detach = () => signal?.removeEventListener('abort', abort);
      try {
        if (seekReuse) {
          await previous.parking; own(record);
          if (previous.seekCancelled || previous.stopSent) throw failure('CANCELLED');
        } else await stop(previous);
        own(record);
        record.process = await ensure(); own(record);
        if (selection.temporaryFormatLease === true && !record.process.capabilities.includes('temporary-format-lease-v1'))
          throw failure('FORMAT_LEASE_UNSUPPORTED');
        if (selection.bootstrapMode === 'paused-source' && !record.process.capabilities.includes('paused-source-bootstrap-v1'))
          throw failure('PROTOCOL_INCOMPATIBLE');
        if (record.bufferedBootstrap && !record.process.boundedBootstrap) throw failure('PROTOCOL_INCOMPATIBLE');
        if (selection.temporaryFormatLease === true && !record.process.capabilities.includes('active-silent-format-lease-v1'))
          throw failure('PROTOCOL_INCOMPATIBLE');
        record.openRequested = true;
        // Retain identities only, never stopped PCM queues, sockets or selections.
        record.process.captureReceipts.set(record.generation, { session, generation: record.generation, nativeFailureObserved: false });
        while (record.process.captureReceipts.size > MAX_CAPTURE_RECEIPTS)
          record.process.captureReceipts.delete(record.process.captureReceipts.keys().next().value);
        if (seekReuse) {
          if (record.process !== previous.process) throw failure('CAPTURE_PROTOCOL_INVALID');
          // From dispatch onward cleanup belongs to the new generation. A late
          // old stop/EOF may not tear down its replacement on the shared owner.
          clearTimeout(previous.seekTimer); previous.nativeOpened = false; previous.adoptedBy = record;
        }
        const prepared = await command(record.process, { action: 'capture-open', session, generation: record.generation,
          pipeName: record.pipeName, ...selection,
          ...(seekReuse ? { seekToken: previous.seekParkReceipt.seekToken, seekTransaction: seekReuse.seekTransaction } : {}) });
        record.nativeOpened = prepared?.state !== 'configuration-required';
        own(record); record.state = requireSnapshot(prepared, record, 'prepared');
        if (selection.temporaryFormatLease === true) record.ownedSilentRenderLease = requireOwnedSilentRenderLease(prepared.ownedSilentRenderLease,
          { session, generation: record.generation, renderDeviceId: selection.renderDeviceId, processId: record.process.child.pid });
        await connect(record); own(record);
        diagnostic('open', record);
        return Object.freeze({
          generation: record.generation, stream: record.queue.stream, receivedFrames: () => record.queue.receivedFrames,
          supportsSeekPark: record.process.seekReuseCapable,
          beginSeekRetirement: transaction => beginSeekRetirement(record, transaction),
          resolveFailure: (error, signal) => resolveFailure(record, error, signal),
          ownedSilentRenderLease() {
            own(record);
            if (!record.ownedSilentRenderLease) throw failure('CAPTURE_PROTOCOL_INVALID');
            return record.ownedSilentRenderLease;
          },
          async start({ positionIntentId } = {}) {
            own(record);
            if (!record.starting && record.bufferedBootstrap) {
              // One deadline spans native start, source confirmation, promotion and the final route proof.
              record.bootstrapDeadline = performance.now() + BOOTSTRAP_TIMEOUT_MS;
              record.bootstrapTimer = setTimeout(() => { void stop(record, 'CAPTURE_BOOTSTRAP_TIMEOUT', true); }, BOOTSTRAP_TIMEOUT_MS);
              record.bootstrapTimer.unref?.();
            }
            // open() separates seekReuse from selection; a retained device must use the ordinary epoch reset.
            const combined = fastInitialEpoch && !seekReuse && sessionId(positionIntentId) && record.bufferedBootstrap;
            if (!record.starting) record.starting = command(record.process, { action: combined ? 'capture-start-position-epoch' : 'capture-start', session, generation: record.generation,
              ...(combined ? { positionIntentId } : {}) })
              .then(value => { own(record); if (combined) {
                  const epoch = value.positionEpoch;
                  if (epoch?.session !== session || epoch.generation !== record.generation || epoch.positionIntentId !== positionIntentId
                    || !Number.isSafeInteger(epoch.cutSequence) || epoch.cutSequence < 1 || epoch.capturedFramesAtCut !== 0
                    || epoch.deliveredFramesAtCut !== 0 || epoch.queuedBytesAtCut !== 0 || epoch.startValidated !== true
                    || epoch.freshBuffer !== true || !Number.isSafeInteger(epoch.stoppedAndResetAtUnixMs) || epoch.stoppedAndResetAtUnixMs <= 0)
                    throw failure('CAPTURE_PROTOCOL_INVALID');
                  record.positionEpoch = record.initialPositionEpoch = epoch; value = value.snapshot;
                }
                record.state = requireSnapshot(value, record, 'running'); diagnostic('running', record); return record.state; })
              .catch(error => { void stop(record, failure(error?.code).code, true); throw failure(error?.code); });
            return record.starting;
          },
          async status() {
            own(record);
            try {
              const value = await command(record.process, { action: 'status', session, generation: record.generation });
              own(record); record.state = requireSnapshot(value, record, record.starting ? 'running' : 'prepared');
              diagnostic('sample', record); return record.state;
            } catch (error) { void stop(record, failure(error?.code).code, true); throw failure(error?.code); }
          },
          async beginPositionEpoch({ positionIntentId } = {}) {
            own(record);
            if (!record.process.positionEpochCapable || !sessionId(positionIntentId)
              || !record.bufferedBootstrap || !record.starting || record.promoted || record.promoting || record.published
              || record.positionEpochRequested) throw failure('CAPTURE_PROTOCOL_INVALID');
            record.positionEpochRequested = true;
            try {
              const value = record.initialPositionEpoch || await command(record.process, { action: 'capture-begin-position-epoch',
                session, generation: record.generation, positionIntentId });
              record.initialPositionEpoch = null;
              own(record);
              if (value?.session !== session || value.generation !== record.generation || value.positionIntentId !== positionIntentId
                || !Number.isSafeInteger(value.cutSequence) || value.cutSequence < 1 || value.capturedFramesAtCut !== 0
                || value.deliveredFramesAtCut !== 0 || value.queuedBytesAtCut !== 0 || value.startValidated !== true
                || value.freshBuffer !== true || !Number.isSafeInteger(value.stoppedAndResetAtUnixMs)
                || value.stoppedAndResetAtUnixMs <= 0 || record.queue.receivedFrames !== 0)
                throw failure('CAPTURE_PROTOCOL_INVALID');
              record.positionEpoch = Object.freeze({ ...value }); return record.positionEpoch;
            } catch (error) { await stop(record, failure(error?.code).code, true); throw error; }
          },
          async promote() {
            own(record);
            if (selection.bootstrapMode !== 'paused-source' || selection.bootstrapDelivery !== 'buffer' || record.promoted)
              throw failure('CAPTURE_PROTOCOL_INVALID');
            record.promoting = true;
            try {
              const value = await command(record.process, { action: 'capture-promote', session, generation: record.generation });
              own(record); record.state = requireSnapshot(value, record, 'running', 'live'); record.promoted = true;
              return record.state;
            } catch (error) { void stop(record, failure(error?.code).code, true); throw error; }
            finally { record.promoting = false; }
          },
          beginPublication() {
            own(record);
            if (!record.bufferedBootstrap || !record.promoted || !record.starting || record.published)
              throw failure('CAPTURE_PROTOCOL_INVALID');
            if (performance.now() >= record.bootstrapDeadline) {
              void stop(record, 'CAPTURE_BOOTSTRAP_TIMEOUT', true); throw failure('CAPTURE_BOOTSTRAP_TIMEOUT');
            }
            const prefixFrames = record.queue.beginPublication(record.state.bootstrapPrefixFrames);
            updatePipeFlow(record);
            record.published = true; clearTimeout(record.bootstrapTimer);
            return prefixFrames;
          },
          stop: () => stop(record), snapshot: () => record.state,
          async stopVerified() {
            await stop(record);
            // A confirmed exit of this exact child also proves capture and its
            // silent render lease stopped; a dead command channel alone does not.
            if (record.process?.exited) return;
            if (record.process?.dead) { await requireExit(record.process); return; }
            if (record.nativeOpened && record.stopVerified !== true) throw failure('CAPTURE_STOP_TIMEOUT');
          },
        });
      } catch (error) {
        await stop(record);
        if (seekReuse && !previous.adoptedBy) await stop(previous);
        // An uncertain token Open may have retired the old generation without
        // returning the new one. Exact child exit is the remaining cleanup proof.
        if (seekReuse && record.openRequested && !record.nativeOpened && !record.process?.exited) {
          breakProcess(record.process, 'CAPTURE_STOP_TIMEOUT'); await requireExit(record.process);
        }
        throw failure(error?.code);
      }
    },
    async verifyStopped() {
      const record = latestCapture;
      if (!record) return;
      await stop(record);
      if (!record.openRequested || record.stopVerified) return;
      // A mode transition cannot adopt "never started" while an older manual generation is uncertain.
      // Retire only our exact child; the same host may create a fresh child for the next mode afterward.
      breakProcess(record.process, 'CAPTURE_STOP_TIMEOUT');
      if (record.process) await requireExit(record.process);
    },
    close() {
      if (closing) return closing;
      closed = true;
      let resolve, reject;
      closing = new Promise((done, failed) => { resolve = done; reject = failed; });
      const source = current, process = processRecord;
      // Revoke publication immediately; only observed own-child exit confirms cleanup.
      let stopFailure;
      try { if (source) { source.nativeOpened = false; void stop(source); } }
      catch (error) { stopFailure = failure(error?.code); }
      // Local disposal must not skip child termination or hide an unconfirmed exit.
      breakProcess(process, 'CAPTURE_HELPER_CLOSED');
      (process ? requireExit(process) : Promise.resolve()).then(() => stopFailure ? reject(stopFailure) : resolve(), reject);
      return closing;
    },
  };
}
module.exports = { createCableCaptureHost };
