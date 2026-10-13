'use strict';
const { createHash } = require('node:crypto');

// electron/debug/privatePreviewDiagnosticSchema.cjs — closed, value-only telemetry projections.
// Never serialize caller objects, invoke getters, or infer original source depth from PCM output.
const own = (object, key) => {
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const choices = values => { const allowed = new Set(values.split(/\s+/)); return value => typeof value === 'string' && allowed.has(value); };
const integer = maximum => value => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const number = maximum => value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const bool = value => typeof value === 'boolean';
const readbackFields = Object.freeze(['sampleRate', 'channels', 'containerBits', 'validBits', 'blockAlign',
    'averageBytesPerSecond', 'encoding', 'channelMask', 'subFormatKind']);
const signed32 = value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647;
// Copy only the failed query's bounded descriptor evidence. No caller object, GUID, path or getter is exported.
function projectFormatLeaseReadback(value) {
    if (!object(value)) return undefined;
    const endpointRole = own(value, 'endpointRole'), comparison = own(value, 'comparison'), periodFrames = own(value, 'periodFrames');
    if (!choices('capture render')(endpointRole) || !choices('rate-or-channels descriptor')(comparison)
        || !integer(4294967295)(periodFrames)) return undefined;
    function format(input) {
        if (!object(input)) return undefined;
        const result = {};
        for (const key of readbackFields.slice(0, 6)) {
            const number = own(input, key); if (!signed32(number)) return undefined; result[key] = number;
        }
        const encoding = own(input, 'encoding'), channelMask = own(input, 'channelMask'), subFormatKind = own(input, 'subFormatKind');
        if (!choices('pcm float unsupported')(encoding) || !integer(4294967295)(channelMask)
            || !choices('none pcm float other')(subFormatKind)) return undefined;
        return Object.freeze({ ...result, encoding, channelMask, subFormatKind });
    }
    const requested = format(own(value, 'requested')), observed = format(own(value, 'observed'));
    const fields = own(value, 'differingFields'), length = own(fields, 'length');
    if (!requested || !observed || !Array.isArray(fields) || !integer(9)(length) || length < 1) return undefined;
    const differingFields = []; let previous = -1;
    for (let index = 0; index < length; index++) {
        const field = own(fields, String(index)), ordinal = readbackFields.indexOf(field);
        if (ordinal <= previous) return undefined;
        previous = ordinal; differingFields.push(field);
    }
    return Object.freeze({ endpointRole, comparison, periodFrames, requested, observed,
        differingFields: Object.freeze(differingFields) });
}
const cableConfigurationIssue = choices('BASE_CABLE_ENDPOINT_REQUIRED ENDPOINT_UNAVAILABLE CAPTURE_RATE_MISMATCH CAPTURE_CHANNELS_MISMATCH CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED CAPTURE_FORMAT_UNSUPPORTED CAPTURE_FORMAT_INVALID RENDER_RATE_MISMATCH RENDER_CHANNELS_MISMATCH CABLE_IS_DEFAULT_RENDER FOLIA_FEEDBACK_ROUTE CABLE_SHARED_WITH_OTHER_AUDIO ROUTE_IDENTITY_UNAVAILABLE ROUTE_OBSERVATION_FAILED SPOTIFY_ROUTE_NOT_FOUND SPOTIFY_PROCESS_AMBIGUOUS');
// Preserve the allowed subset of simultaneous format and route failures, never native identities or caller arrays.
function projectConfigurationIssueCodes(configuration) {
    const issues = own(configuration, 'issues'), length = own(issues, 'length');
    if (!Array.isArray(issues) || !integer(32)(length)) return undefined;
    const codes = new Set();
    for (let index = 0; index < length; index++) {
        const code = own(issues, String(index));
        if (cableConfigurationIssue(code)) codes.add(code);
    }
    return length === 0 || codes.size ? [...codes].sort().join(' ') : undefined;
}
const configurationIssueCodes = value => typeof value === 'string' && value.length <= 1024
    && (value === '' || value.split(' ').length <= 16 && value.split(' ').every(cableConfigurationIssue)
        && [...new Set(value.split(' '))].sort().join(' ') === value);
const backend = choices('browser wasapi-exclusive asio hqplayer unknown');
const operation = choices('begin finish play pause seek stop volume replaygain gain devices status hello chunk cached-source hqplayer-status hqplayer-window hqplayer-shutdown hqplayer-component-install hqplayer-component-uninstall hqplayer-component-rollback hqplayer-authorize-existing hqplayer-launch-options hqplayer-dsp-read hqplayer-dsp-apply hqplayer-select-executable hqplayer-reset-executable component-install component-uninstall component-rollback output-switch unknown');
const errorCodes = `UNKNOWN HQPLAYER_CONFIRM_EXISTING HQPLAYER_MULTIPLE_INSTANCES STRICT_DECODE_FAILED HQPLAYER_SETTINGS_FAILED HQPLAYER_PATH_INVALID HQPLAYER_UNAVAILABLE HQPLAYER_CONTROL_UNAVAILABLE HQPLAYER_COMMAND_REJECTED HQPLAYER_SOURCE_REJECTED COMPONENT_CRASHED COMPONENT_TIMEOUT COMPONENT_UNAVAILABLE COMPONENT_INTEGRITY COMPONENT_INCOMPATIBLE COMPONENT_UPDATE_FAILED ROLLBACK_UNAVAILABLE SOURCE_RESTORE_UNCONFIRMED SOURCE_UNAVAILABLE SOURCE_EXPIRED SOURCE_TOO_LARGE DECODE_FAILED DEVICE_UNAVAILABLE FORMAT_UNSUPPORTED INVALID_REQUEST CANCELLED NATIVE_REQUEST_FAILED auth-required unsupported unavailable not-playable network invalid-response INVALID_REQUEST PROTOCOL_INVALID SOLOIST_ASSET_UNVERIFIED SOLOIST_ASSET_MISMATCH APPLIANCE_USER_REQUIRED PROCESS_UNAVAILABLE SOCKET_SCAN_INCOMPLETE SOLOIST_BINARY_INVALID SOLOIST_BINARY_CHANGED SOCKET_OWNER_MISMATCH SOCKET_OWNER_AMBIGUOUS MA_ANCESTRY_MISMATCH MA_OWNER_CHANGED SOLOIST_PROCESS_MISMATCH OWNER_CHANGED MA_DATA_UNAVAILABLE SOLOIST_CONTROL_AMBIGUOUS SOLOIST_CONTROL_UNSAFE MA_SERVICE_UNAVAILABLE PLAYBACK_SCHEMA_INVALID AUTH_OR_ACTIVE_CHANGED PAUSED_TEST_REQUIRED TRACK_CHANGED EXTERNAL_POSITION_CHANGED POSITION_INVALID SOLOIST_INSTALL_REQUIRED SOLOIST_STARTING ZC_RESPONSE_TOO_LARGE ZC_CONTROL_UNAVAILABLE AUTH_SCHEMA_INVALID PLAYBACK_UNAVAILABLE WS_COMMAND_REJECTED COMMAND_UNAVAILABLE COMMAND_TIMEOUT RESPONSE_TOO_LARGE OWNED_CONTROL_UNAVAILABLE OWNED_CONTROL_TIMEOUT CODEC_DIAGNOSTICS_UNAVAILABLE INVALID_DIAGNOSTICS DIAGNOSTIC_APPLIANCE_CHANGED DIAGNOSTIC_OWNER_INVALID DIAGNOSTIC_AUTH_REQUIRED DIAGNOSTIC_DAEMON_CHANGED DIAGNOSTIC_TRACK_CHANGED DIAGNOSTIC_WINDOW_EXPIRED DIAGNOSTIC_FILE_CHANGED DIAGNOSTIC_FILE_UNSAFE DIAGNOSTIC_READ_FAILED PUBLIC_CONTROL_UNTRUSTED TRACK_NOT_CURRENT STALE_SESSION SUPERSEDED APPLIANCE_UNAVAILABLE CONTROL_TIMEOUT CONTROL_FAILED CONTROL_RESPONSE_TOO_LARGE CONTROL_REJECTED CONTROL_PROTOCOL_INVALID CONTROL_BUSY AUTH_REQUIRED DEVICE_INACTIVE PLAYBACK_STATE_UNCONFIRMED SEEK_UNCONFIRMED READER_ALREADY_USED NOT_PREPARED PCM_SOURCE_UNAVAILABLE PCM_FORMAT_INVALID PCM_BLOCK_INVALID PCM_DURATION_EXCEEDED PCM_TRUNCATED PCM_INTERRUPTED`;
const errorCode = choices(`${errorCodes} HQPLAYER_RAW_FORMAT_UNVERIFIED setup-required API_FORBIDDEN API_UNAVAILABLE SCOPES_UNKNOWN SCOPE_REQUIRED SESSION_CHANGED RATE_LIMITED DEVICE_ID_UNAVAILABLE OWNERSHIP_UNKNOWN
    APPLIANCE_CHANNEL_UNAVAILABLE APPLIANCE_CHANGED OWNED_PROTOCOL_INVALID
    SSH_CONNECTION_REFUSED SSH_CONNECTION_TIMEOUT SSH_HOST_KEY_REJECTED SSH_CLIENT_KEY_PERMISSIONS SSH_CLIENT_KEY_UNAVAILABLE SSH_AUTHENTICATION_FAILED SSH_WINDOWS_PERMISSION_DENIED
    INVALID_QUALITY APPLIANCE_CLOSED APPLIANCE_COMPONENT_UNAVAILABLE APPLIANCE_COMPONENT_INVALID APPLIANCE_COMPONENT_CHANGED
    SECRET_ENCRYPTION_REQUIRED SECRET_DIRECTORY_UNSAFE SECRET_VAULT_INVALID SECRET_VAULT_WRITE_FAILED SOLOIST_KEY_REQUIRED SOLOIST_KEY_INVALID
    APPLIANCE_PREPARATION_FAILED SOLOIST_DOWNLOAD_FAILED GUEST_REQUEST_TOO_LARGE GUEST_PROTOCOL_INVALID GUEST_CONTROL_TIMEOUT ASSET_INSTALL_UNCONFIRMED
    CREDENTIALS_NOT_READY APPLIANCE_RUNTIME_STARTING APPLIANCE_RUNTIME_TIMEOUT APPLIANCE_SSH_NOT_READY SOLOIST_START_TIMEOUT
    RUNTIME_IDENTITY_CLEANUP_FAILED QUALITY_PROTOCOL_INVALID QUALITY_CONFIGURATION_FAILED QUALITY_PAIRING_REQUIRED PRIVATE_RUNTIME_REQUIRED
    PRIVATE_CREDENTIAL_UNSAFE PRIVATE_CREDENTIAL_CHANGED QUALITY_BUSY QUALITY_LOCK_UNSAFE PAUSED_OWNED_SOURCE_REQUIRED PROVIDER_QUALITY_UNKNOWN
    QUALITY_SAVE_UNCONFIRMED QUALITY_RESTORE_UNCONFIRMED QUALITY_READBACK_UNCONFIRMED MA_COMMAND_REJECTED MA_RESPONSE_INVALID MA_AUTH_REQUIRED
    PROVIDER_OWNER_CHANGED RECEIVER_CREDENTIAL_UNSAFE RECEIVER_STATUS_UNAVAILABLE PCM_SESSION_BUSY EXTERNAL_PLAYBACK_CHANGE
    PROVIDER_UNLOAD_TIMEOUT PROVIDER_RESTORE_TIMEOUT ASSET_REQUEST_TOO_LARGE ASSET_REQUEST_INVALID ASSET_ARCHIVE_MISMATCH ASSET_ARCHIVE_INVALID
    ASSET_EXTRACTED_TOO_LARGE ASSET_ELF_INVALID ASSET_INSTALL_UNSAFE ASSET_RUNTIME_ALREADY_STARTED ASSET_BINARY_MISMATCH ASSET_CONTRACT_CHANGED
    ASSET_BUILD_EXPIRED ASSET_BINARY_INVALID ASSET_INSTALL_FAILED INVALID_PUBLIC_KEY PUBLIC_KEY_CHANGED UNSAFE_OWNER UNSAFE_DIRECTORY
    INVALID_HOST_KEY HOST_KEY_CHANGED HOST_KEY_MISMATCH UNSAFE_PRIVATE_FILE FIRMWARE_INPUT_TOO_LARGE INVALID_HOST_PORT INVALID_DEVICE_NAME
    HOST_CONFIGURATION_CHANGED INVALID_CREDENTIALS RUNTIME_CREDENTIAL_CHANGED BOOT_INPUT_MISSING BOOT_PERMISSION_DENIED APPLIANCE_BOOT_FAILED
    DISCOVERY_PROTOCOL_INVALID DISCOVERY_IDENTITY_CHANGED DISCOVERY_UNAVAILABLE DISCOVERY_INTERFACE_UNAVAILABLE PRIVATE_DIRECTORY_UNSAFE
    PRIVATE_DIRECTORY_CHANGED PRIVATE_DIRECTORY_PERMISSION_FAILED PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE PRIVATE_DIRECTORY_CONTROL_TIMEOUT PRIVATE_DIRECTORY_PROTOCOL_INVALID
    BASE_CABLE_ENDPOINT_REQUIRED CABLE_IS_DEFAULT_RENDER CABLE_SHARED_WITH_OTHER_AUDIO CABLE_FORMAT_REQUIRED CABLE_CONFIRMATION_REQUIRED
    CAPTURE_BUFFER_INVALID CAPTURE_CHANNELS_MISMATCH CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED CAPTURE_CLOSED CAPTURE_DEVICE_BUFFER_TOO_LARGE CAPTURE_DEVICE_FAILED
    CAPTURE_DISCONTINUITY CAPTURE_FORMAT_CHANGED CAPTURE_FORMAT_INVALID CAPTURE_FORMAT_UNSUPPORTED CAPTURE_FRAME_INVALID CAPTURE_INITIALIZE_TIMEOUT
    CAPTURE_OVERFLOW CAPTURE_BOOTSTRAP_TIMEOUT CAPTURE_PACKET_INVALID CAPTURE_PACKET_TOO_LARGE CAPTURE_PADDING_NONZERO CAPTURE_PIPE_CONNECT_TIMEOUT CAPTURE_PIPE_FAILED
    CAPTURE_PIPE_NOT_CONNECTED CAPTURE_RATE_MISMATCH CAPTURE_REQUEST_FAILED CAPTURE_SAMPLE_NONFINITE CAPTURE_START_TIMEOUT CAPTURE_STATE_INVALID
    CAPTURE_STOP_TIMEOUT CAPTURE_TIMESTAMP_ERROR CAPTURE_UNSUPPORTED_PLATFORM CAPTURE_PROTOCOL_INVALID CAPTURE_CONTROL_TIMEOUT CAPTURE_CONTROL_BUSY
    CAPTURE_HELPER_UNAVAILABLE CAPTURE_HELPER_CLOSED CAPTURE_HELPER_EXITED CAPTURE_HELPER_EXIT_UNCONFIRMED CAPTURE_PIPE_TRUNCATED CAPTURE_CONFIGURATION_REQUIRED
    CAPTURE_PIPE_TIMEOUT CAPTURE_PIPE_CLOSED CAPTURE_READER_USED CAPTURE_READ_PENDING ENDPOINT_UNAVAILABLE FOLIA_FEEDBACK_ROUTE
    FORMAT_LEASE_CLOSED FORMAT_LEASE_FAILED FORMAT_LEASE_LOCKED FORMAT_LEASE_PERIOD_INVALID FORMAT_LEASE_READBACK_FAILED FORMAT_LEASE_READBACK_MISMATCH
    FORMAT_LEASE_UNSUPPORTED FORMAT_LEASE_ENDPOINT_MISMATCH FORMAT_LEASE_IDENTITY_UNAVAILABLE FORMAT_LEASE_IDENTITY_LIMIT
    CAPTURE_BUSY HELPER_RESTART_REQUIRED PROCESS_LIMIT PROTOCOL_INCOMPATIBLE RENDER_CHANNELS_MISMATCH RENDER_RATE_MISMATCH
    ROUTE_IDENTITY_UNAVAILABLE ROUTE_OBSERVATION_FAILED ROUTE_SESSION_LIMIT ROUTE_PROBE_FAILED SPOTIFY_PROCESS_AMBIGUOUS SPOTIFY_PROCESS_CHANGED
    SPOTIFY_ROUTE_NOT_FOUND STALE_GENERATION WINDOWS_REQUIRED DEVICE_NOT_SELECTED DEVICE_NOT_LISTED DEVICE_NOT_COMPUTER DEVICE_RESTRICTED
    DUPLICATE_DEVICE_ID DEVICE_ID_MISMATCH CLOSED ROUTE_HELPER_UNAVAILABLE ROUTE_COMPONENT_INVALID ROUTE_HELPER_UNQUALIFIED
    ROUTE_PROTOCOL_INVALID ROUTE_CONTROL_TIMEOUT ROUTE_HELPER_CLOSED ROUTE_HELPER_EXIT_UNCONFIRMED ROUTE_HELPER_ABNORMAL_EXIT ROUTE_RESTORE_UNCONFIRMED
    MUTED_PREPARATION_UNSUPPORTED MUTED_PREPARATION_INVALID_STATE MUTED_PREPARATION_PROOF_REQUIRED MUTED_PREPARATION_IN_PROGRESS
    ROUTE_SOURCE_DEFAULT_REQUIRED ROUTE_PROOF_UNCONFIRMED ROUTE_LEASE_LOST ROUTE_BUSY ROUTE_SOURCE_PAUSE_UNCONFIRMED
    BOOTSTRAP_VOLUME_UNAVAILABLE BOOTSTRAP_VOLUME_UNCONFIRMED BOOTSTRAP_VOLUME_RECOVERY_REQUIRED BOOTSTRAP_IDENTITY_UNCONFIRMED
    NATIVE_PRODUCT_ADAPTER_UNQUALIFIED AUTOMATIC_ROUTE_ON_PLAY ROUTE_TRIAL_OPT_IN_REQUIRED ROUTE_TRIAL_PLATFORM_MISMATCH
    SPOTIFY_CLIENT_OUTPUT_CONFIRMATION_REQUIRED CABLE_INTERNAL_RATE_CONFIRMATION_REQUIRED ORIGINAL_POLICY_UNSAFE
    ORIGINAL_POLICY_PROOF_REQUIRED RECOVERY_ORIGINAL_BINDING_REQUIRED WINDOWS_PRODUCT_JOURNAL_REQUIRED
    ORIGINAL_POLICY_VALUES_INVALID ORIGINAL_POLICY_ENDPOINT_UNRESOLVED ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS
    ORIGINAL_ENDPOINT_UNSAFE ORIGINAL_PHYSICAL_OWNER_UNPROVEN ORIGINAL_EXPLICIT_ENDPOINT_CHANGED
    NON_BASE_DEFAULT_OUTPUT_REQUIRED ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN
    NATIVE_PRODUCT_ADAPTER_UNQUALIFIED PRODUCT_DISCOVERY_UNQUALIFIED EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN SPOTIFY_AUDIO_PROCESS_AMBIGUOUS
    SPOTIFY_DISCOVERY_TIMEOUT COMPLETE_SPOTIFY_DISCOVERY_REQUIRED SPOTIFY_INSTANCE_CHANGED SPOTIFY_CANDIDATE_SET_CHANGED
    ORIGINAL_POLICY_VALUES_INVALID ORIGINAL_POLICY_ENDPOINT_UNRESOLVED ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS ORIGINAL_ENDPOINT_UNSAFE
    ORIGINAL_PHYSICAL_OWNER_UNPROVEN ORIGINAL_EXPLICIT_ENDPOINT_CHANGED NON_BASE_DEFAULT_OUTPUT_REQUIRED ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN
    INSPECTED_ORIGINALS_CHANGED POLICY_CHANGED_BEFORE_APPLY EXTERNAL_POLICY_CONFLICT COMMUNICATIONS_POLICY_CHANGED
    EXACT_BASE_PAIR_REQUIRED EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH BASE_PAIR_CHANGED BASE_OTHER_WRITER_PRESENT
    SOURCE_PAUSE_CONFIRMATION_REQUIRED SOURCE_NOT_PAUSED SOURCE_TRACK_CHANGED SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH
    SOURCE_RESUMED_DURING_PAUSE_PROOF PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED PCM_STOP_NOT_CONFIRMED SOURCE_BROKER_UNAVAILABLE
    SOURCE_BROKER_FAILED SOURCE_STATUS_REQUIRED SOURCE_PAUSE_NOT_CONFIRMED SOURCE_PAUSE_DEVICE_MISMATCH
    RECOVERY_PLAYBACK_OWNERSHIP_UNCONFIRMED PRODUCT_CONTROL_AUTHORITY_LOST PRODUCT_PARENT_APPLY_AUTHORITY_LOST SUPERVISOR_CANCELLED
    APPLY_READBACK_MISMATCH RESTORE_READBACK_MISMATCH SESSION_OBSERVATION_UNTRUSTED JOURNAL_COMMIT_FAILED_NO_MORE_POLICY_WRITES
    PRODUCT_PREPARED_ACK_MISMATCH PREPARED_RETAIN_ACK_INVALID JOURNAL_STORAGE_IDENTITY_UNSAFE PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED
    PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED PRODUCT_JOURNAL_PARENT_REQUIRED PRODUCT_JOURNAL_PARENT_OPEN_FAILED
    PRODUCT_JOURNAL_ROOT_CREATE_FAILED PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED JOURNAL_SECURITY_CHANGED PRODUCT_OPERATION_FAILED
    NO_POLICY_WRITES EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN SPOTIFY_AUDIO_PROCESS_AMBIGUOUS SOURCE_DEFAULT_POLICY_REQUIRED`);
const phase = choices('request result release cancel');
const sessionRef = integer(2147483647);
const spotifyCommand = choices('loginBegin loginImage loginCheck loginCancel status logout search playlists savedTracks song playlist playlistTracks album albumTracks audio cancelAudio configure configuration playbackSetup browser-open browser-read browser-play browser-pause browser-seek browser-close browser-begin browser-position browser-start browser-pull browser-stop read seek play pause stop prepare close release resetPlayback shutdown service-create unknown');
const spotifyContext = { sessionRef, operationRef: sessionRef, playlistRef: sessionRef, layer: choices('service ipc browser-service browser-ipc setup lifecycle'), command: spotifyCommand,
    operation: choices('status saveKey start stop keyPage devices saveSelection probe openDriver openSoundSettings openCablePanel checkColdRecovery'), requestedQuality: choices('standard high lossless hires') };
const common = { sessionRef, backend, ok: bool, errorCode };
const typeCategory = choices('missing null boolean number string array object unknown');
const spotifyEndpoint = choices('catalog-profile catalog-search catalog-playlists catalog-saved-tracks catalog-track catalog-playlist catalog-playlist-items catalog-album catalog-album-tracks playback-track playback-select playback-profile playback-devices playback-state playback-transfer playback-play playback-pause playback-seek playback-volume');
const exitCode = value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 4294967295;
const reason = choices('normal exit before-quit will-quit uncaught-exception unhandled-rejection clean-exit abnormal-exit killed crashed oom launch-failed integrity-failure memory-eviction unknown');
const events = {
    'run.start': { platform: choices('win32 linux darwin'), arch: choices('x64 arm64 ia32'), packaged: bool,
        appVersion: value => version(value), electronVersion: value => version(value), buildId: value => typeof value === 'string' && /^\d{8}$/.test(value), soloistManifestSha256: value => hash(value) },
    'run.end': { reason },
    'process.termination': { kind: choices('main renderer GPU Utility Zygote SandboxHelper PepperPlugin PepperPluginBroker unknown'), reason, exitCode },
    'native.command': { ...common, operationRef: sessionRef, operation, phase, positionSeconds: number(604800) },
    'native.release': { ...common, phase, releaseAcknowledged: bool, reason: choices('stop handoff replaced renderer-gone navigation provider-change shutdown unknown') },
    'native.progress': { ...common, stage: choices('connect load download decode buffer ready unknown'), elapsedMs: integer(604800000), loaded: integer(2 ** 42), total: integer(2 ** 42), complete: bool, unit: choices('bytes milliseconds') },
    'native.state': { ...common, playing: bool, ended: bool, buffering: bool, positionSeconds: number(604800), durationSeconds: number(604800), bufferedStart: number(604800), bufferedEnd: number(604800), producerComplete: bool },
    'native.format': { ...common, formatStage: choices('prepared-pcm engine-output'), sourceSampleRate: integer(1536000), sourceBitsPerSample: integer(64), sourceBitrate: integer(100000000), sourceCodec: choices('PCM FLAC ALAC AAC VORBIS OPUS MP3 DSD APE WAVPACK UNKNOWN'), sourceEncodingVerified: bool, preparedSource: bool, requestedQuality: choices('standard high lossless hires'), sourceQuality: choices('standard high lossless hires'), outputSampleRate: integer(1536000), outputBitsPerSample: integer(64), outputChannels: integer(32), outputFormat: choices('s16le s24le s32le f32le f64le pcm16 pcm24 pcm32 float32 float64 dsd unknown') },
    'native.device': { ...common, phase: choices('opening opened released failed enumerated'), deviceCount: integer(4096) },
    'native.pcm': { ...common, phase: choices('sample final'), frames: integer(2 ** 42), zeroSamples: integer(2 ** 42), nonzeroSamples: integer(2 ** 42), bytes: integer(2 ** 42), elapsedMs: integer(604800000) },
    'native.hq-input': { sessionRef, generation: integer(2147483647), phase: choices('accepted rejected'), errorCode,
        inputSampleRate: integer(1536000), inputChannels: integer(32), inputContainerBits: integer(64) },
    'native.hq-experiment': { ...common, phase: choices('configured waiting delay ready playing buffering sample final'),
        generation: integer(2147483647), enabled: bool, prebufferMs: integer(2000), startupDelayMs: integer(1000),
        elapsedMs: integer(604800000), prebufferWaitMs: integer(604800000), startupWaitMs: integer(604800000),
        componentReady: bool, outputReadyWaitMs: integer(604800000),
        estimatedBufferedMs: integer(604800000), queueDepthMs: integer(10000), queueSampleAgeMs: integer(604800000), bufferCapacityBytes: integer(2 ** 30),
        buffering: bool, bufferingEvents: integer(2147483647), inputBytes: integer(2 ** 42), pipeInputBytesPerSecond: integer(2 ** 32),
        pipeInputMaxGapMs: integer(604800000), sampleRate: integer(384000), channels: integer(8), bitsPerSample: integer(32), pcmFormat: choices('s32le') },
    'spotify.command': { ...common, ...spotifyContext, phase, releaseAcknowledged: bool },
    'spotify.http': { endpoint: spotifyEndpoint, method: choices('GET PUT'), operationRef: sessionRef, playlistRef: sessionRef,
        httpStatus: value => integer(599)(value) && value >= 100,
        pageOffset: integer(100000), pageLimit: value => integer(50)(value) && value >= 1,
        rawCount: integer(2147483647), totalCount: integer(2147483647), hasContinuation: bool,
        responseOffset: integer(100000), responseLimit: value => integer(50)(value) && value >= 1,
        pageShape: choices('root items tracks missing'), collaborative: bool,
        inspectedCount: integer(50), itemEnvelopeCount: integer(50), trackEnvelopeCount: integer(50), directItemCount: integer(50),
        nullItemCount: integer(50), localItemCount: integer(50), episodeItemCount: integer(50), invalidItemCount: integer(50),
        trackItemCount: integer(50), restrictedItemCount: integer(50) },
    'spotify.playback-control': { endpoint: spotifyEndpoint, method: choices('GET PUT'),
        httpStatus: value => integer(599)(value) && value >= 100, phase: choices('acknowledged unconfirmed state-confirmed failed'), errorCode,
        bodyShape: choices('unknown empty null empty-object nonempty-json error-json plain-text invalid-text invalid-utf8 bom-text too-large unreadable'), bodyBytes: integer(4097),
        observationCount: integer(10001), deviceMatched: bool, trackMatched: bool, paused: bool,
        stablePosition: bool, positionWithinTolerance: bool, playing: bool, progressPlausible: bool, emptyState: bool,
        contentType: choices('json text html other missing'), contentEncoding: choices('identity gzip br deflate other missing') },
    'spotify.playlist': { operationRef: sessionRef, playlistRef: sessionRef,
        phase: choices('directory-page directory-item open api-result fallback-check fallback-result'),
        source: choices('api public cache unknown'), reason: choices('allowed not-forbidden continuation not-listed owned collaborative-playlist private unknown expired ineligible failed invalid-schema stale'),
        ownerSelf: choices('yes no unknown'), publicState: choices('yes no unknown'), collaborativeState: choices('yes no unknown'),
        listed: bool, eligible: bool, ok: bool, partial: bool, complete: bool, capped: bool,
        pageOffset: integer(100000), pageLimit: integer(50), rawCount: integer(100000), totalCount: integer(100000),
        inspectedCount: integer(50), hasContinuation: bool, cachedCount: integer(100000), resultCount: integer(100000),
        httpStatus: value => integer(599)(value) && value >= 100, errorCode },
    'spotify.library': { refreshRef: sessionRef, playlistRef: sessionRef,
        phase: choices('refresh-start refresh-result hydrate cache-before cache-after cache-replace normalized-page normalized-item dedup-page'),
        source: choices('api public cache mixed unknown'), reason: choices('success failed cancelled replaced retained removed invalid-row unknown'),
        ownerSelf: choices('yes no unknown'), publicState: choices('yes no unknown'), collaborativeState: choices('yes no unknown'),
        ok: bool, capped: bool, accountChanged: bool, revisionChanged: bool, hasContinuation: bool,
        pageOffset: integer(100000), nextOffset: integer(100000), rawCount: integer(100000), normalizedCount: integer(100000),
        droppedCount: integer(100000), duplicateCount: integer(100000), invalidCount: integer(50), nullCount: integer(50), inspectedCount: integer(100000),
        beforeCount: integer(100000), afterCount: integer(100000), publicBeforeCount: integer(100000), publicAfterCount: integer(100000), removedCount: integer(100000), errorCode },
    'spotify.scopes': { scopesKnown: bool, playlistReadPrivate: bool, playlistReadCollaborative: bool, userLibraryRead: bool, playbackRead: bool, playbackModify: bool },
    'spotify.preparation': { sessionRef, stage: choices('scope quality-setup track-metadata association playback-select pcm-prepare publish cleanup'), errorCode, causeCode: errorCode },
    'spotify.cold-bootstrap': { sessionRef, stage: choices('baseline mute activate select inspect restore cleanup'),
        phase: choices('observed failed completed'), errorCode, causeCode: errorCode, observationCount: integer(10001),
        baselineEmpty: bool, observedEmpty: bool, deviceMatched: bool, paused: bool, volumeMatched: bool,
        selectInvoked: bool, selectConfirmed: bool, activationConfirmed: bool, receiptRetained: bool },
    'spotify.state': { ...common, ...spotifyContext, state: choices('unconfigured stopped starting ready pairing-required failed closed unknown unsupported driver-missing spotify-missing selection-required routing-required format-mismatch probing'),
        available: bool, playing: bool, paused: bool, stopped: bool, complete: bool, changed: bool,
        positionSeconds: number(604800), durationSeconds: number(604800), generation: integer(2147483647),
        outputSampleRate: integer(1536000), outputBitsPerSample: integer(64), outputChannels: integer(32) },
    'spotify.auth': { state: choices('authenticated unauthenticated active inactive ready starting unknown'), authenticated: bool, active: bool, errorCode },
    'spotify.auth-read': { phase, stage: choices('initial-auth state-auth seek-auth read'), ok: bool, authenticated: bool, active: bool, errorCode, reason: choices('frame-type json-invalid top-level-type event-type logged-in-type is-active-type'), frameType: choices('CONTINUATION TEXT BINARY PING PONG CLOSE CLOSING CLOSED ERROR UNKNOWN'), topLevelType: typeCategory, eventType: typeCategory, loggedInType: typeCategory, isActiveType: typeCategory, closeCode: integer(65535), observation: integer(2147483647), elapsedMs: integer(604800000) },
    'spotify.discovery': { phase: choices('retry result'), stage: choices('channel owned-snapshot owned-recheck relay-get-info interfaces host-listen mdns-ready mdns-publish ready'), ok: bool, errorCode, causeCode: errorCode, attempt: integer(128) },
    'spotify.output-handoff': { ...common, phase },
    'spotify.capture': { sessionRef, errorCode, phase: choices('open running sample stopped failed native-failed native-terminal'),
        snapshotSource: choices('command-reply cached-command-reply native-terminal'), captureState: choices('failed closed'), cleanupConfirmed: bool,
        hresult: value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647,
        failureStage: choices('initialize start read stop pipe'),
        bootstrapMode: choices('paused-source'), bootstrapDelivery: choices('buffer discard'),
        deliveryState: choices('closed buffering discarding live'), generation: integer(2147483647),
        captureSampleRate: integer(384000), captureChannels: integer(8), captureBits: integer(64),
        renderSampleRate: integer(384000), renderChannels: integer(8), renderBits: integer(64),
        capturedFrames: integer(2 ** 42), deliveredFrames: integer(2 ** 42), queuedBytes: integer(27871200), queueCapacityBytes: integer(27871200),
        initialDiscontinuity: bool, routeSpotifyOnly: bool, formatLeaseApplied: bool, formatLeaseReleased: bool },
    'spotify.route-operation-failure': { operation: choices('inspect'), errorCode,
        stage: choices('worker-start inspect-request'),
        cause: choices('unknown request-cancelled worker-start-failed worker-image-invalid worker-identity-unconfirmed worker-image-mismatch worker-process-identity-changed worker-sid-unavailable worker-unavailable worker-eof worker-protocol-invalid worker-stderr-limit journal-context-unavailable journal-root-unavailable journal-root-unsafe journal-security-rejected access-denied io-failed invalid-data json-invalid object-disposed platform-unsupported win32-failed') },
    'spotify.route-lease': { sessionRef, errorCode, phase: choices('held-paused resume-authorized active restored failed'),
        generation: integer(2147483647), ready: bool, exactOriginalRolesRestored: bool, observedDefaultsChanged: bool, globalDefaultsWritten: bool },
    'spotify.route-owner-proof': {
        operation: choices('inspect acquire armCaptureInterval authorizeResume status heartbeat release close'),
        errorCode: choices('ORIGINAL_PHYSICAL_OWNER_UNPROVEN ORIGINAL_EXPLICIT_ENDPOINT_CHANGED'),
        stage: choices('topology-enumerator topology-endpoint topology-activate topology-connector-count topology-connector topology-connected topology-adapter-id topology-adapter topology-properties topology-instance-id topology-release owner-locate owner-device-id owner-class-guid owner-hardware-ids owner-service owner-status owner-enumerator owner-bus-type owner-parent owner-identity owner-repeat'),
        reason: choices('api-failed unavailable wrong-type malformed out-of-bounds disconnected ambiguous unsupported virtual mismatch cycle depth-limit not-started has-problem changed release-failed'),
        role: integer(1), originalKind: choices('default explicit'), depth: integer(3),
        nativeResult: integer(4294967295), hresult: value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647,
        property: choices('class-guid hardware-ids service enumerator bus-type device-id'),
        propertyType: integer(4294967295), propertyLength: integer(4096), bus: choices('usb hdaudio pci vendor virtual unknown'),
    },
    'spotify.capture-helper': { phase: choices('hello result failed inventory'), operation: choices('hello devices inspect-route format-probe capture-open capture-start capture-stop status close'),
        ok: bool, errorCode, configurationIssueCodes, hresult: exitCode, processPlatform: choices('win32 linux darwin'), processArchitecture: choices('x64 arm64 ia32'),
        protocolMajor: integer(65535), helperPlatform: choices('win32-x64 win32-arm64 win32-ia32'), helloCompatible: bool,
        baseCableCapability: bool, pcmPipeCapability: bool, routeObservationCapability: bool, temporaryFormatLeaseCapability: bool,
        captureEndpointCount: integer(256), renderEndpointCount: integer(256),
        endpointInventoryState: choices('complete partial limit failed'), endpointActiveCount: integer(256),
        endpointDisabledCount: integer(256), endpointNotPresentCount: integer(256), endpointUnpluggedCount: integer(256),
        endpointUnreadableCount: integer(256), endpointHresult: exitCode,
        controlInterfaceState: choices('complete failed limit unavailable'), controlInterfaceCount: integer(64),
        controlInterfaceActiveCount: integer(64), controlInterfaceWin32Error: integer(4294967295),
        controlInterfaceFailureStage: choices('create-set enumerate load-api release-set'),
        singleCaptureMixSampleRate: integer(384000), singleCaptureChannels: integer(8), singleCaptureBits: integer(64),
        singleRenderMixSampleRate: integer(384000), singleRenderChannels: integer(8), singleRenderBits: integer(64) },
    'spotify.cable-setup': { operation: spotifyContext.operation, operationRef: sessionRef,
        state: choices('unsupported driver-missing endpoints-missing spotify-missing selection-required routing-required format-mismatch stopped probing starting ready failed'),
        errorCode, captureEndpointCount: integer(256), renderEndpointCount: integer(256), endpointPairDetected: bool,
        spotifyRunning: bool, driverInstallerAvailable: bool, connectSelected: bool, captureSelected: bool, renderSelected: bool,
        selectedSpotifyListed: bool, selectedSpotifyActive: bool, captureMixSampleRate: integer(384000), renderMixSampleRate: integer(384000),
        internal44100Confirmed: bool, spotifyOnlyConfirmed: bool, defaultsConfirmed: bool,
        channels: integer(8), temporaryFormatLeaseEligible: bool, formatLeaseApplied: bool, routeVerified: bool,
        vendorLaunchAcknowledged: bool, installationVerification: choices('unknown') },
    'spotify.process': { kind: choices('appliance control reader unknown'), reason, exitCode },
    'output.handoff': { ...common, phase: choices('request result release cancel registered unregistered requested rejected captured cancelled discarded waiting deferred restoring restored restore-failed'), fromBackend: backend, toBackend: backend, positionSeconds: number(604800), playing: bool, operation, reason: choices('user restore superseded provider-change shutdown error unknown no-owner no-deck no-source source-mismatch outgoing-error-retained source-changed output-not-committed effect-replaced checkpoint-replaced deck-replaced deck-error metadata restore-rejected restore-aborted') },
    'renderer.native-error': { operation, errorCode, sessionRef, toBackend: backend },
};
const required = { 'native.command': ['operation', 'phase'], 'native.release': ['phase'], 'native.progress': ['stage'], 'native.device': ['phase'], 'native.pcm': ['phase'], 'native.hq-experiment': ['phase'], 'spotify.command': ['command', 'phase'], 'spotify.http': ['endpoint', 'method', 'httpStatus'], 'spotify.playback-control': ['endpoint', 'method', 'httpStatus', 'phase'], 'spotify.scopes': ['scopesKnown'], 'spotify.preparation': ['stage', 'errorCode', 'causeCode'], 'spotify.auth-read': ['phase'], 'spotify.discovery': ['phase', 'stage'], 'output.handoff': ['phase'], 'renderer.native-error': ['operation', 'errorCode'], 'process.termination': ['kind', 'reason'] };
const RENDERER_EVENTS = Object.freeze(['output.handoff', 'renderer.native-error', 'spotify.library']);
required['spotify.playlist'] = ['phase'];
required['spotify.library'] = ['phase'];
required['native.hq-input'] = ['sessionRef', 'generation', 'phase'];
required['spotify.route-owner-proof'] = ['operation', 'errorCode', 'stage', 'reason'];
required['spotify.cold-bootstrap'] = ['sessionRef', 'stage', 'phase'];
required['spotify.route-operation-failure'] = ['operation', 'errorCode', 'stage', 'cause'];

function projectEvent(type, fields) {
    if (typeof type !== 'string' || !Object.hasOwn(events, type) || !object(fields)) return null;
    const result = {};
    for (const [key, validate] of Object.entries(events[type])) {
        const value = own(fields, key);
        if (value !== undefined && validate(value)) result[key] = value;
    }
    if (type === 'spotify.capture' && result.phase === 'native-terminal' && result.snapshotSource === 'native-terminal'
        && result.captureState === 'failed' && result.errorCode === 'FORMAT_LEASE_READBACK_MISMATCH') {
        const readback = projectFormatLeaseReadback(own(fields, 'formatLeaseReadback'));
        if (readback) result.formatLeaseReadback = readback;
    }
    if ((required[type] || []).some(key => !Object.hasOwn(result, key))) return null;
    return { type, fields: Object.freeze(result) };
}

const SOURCE_FILES = Object.freeze([
    'electron/spotify/runtime.cjs',
    'src/components/modal/settings/SpotifyCableSetupNotice.tsx',
    'src/hooks/usePlaybackTransportController.ts',
    'src/services/playbackSourceRequest.ts', 'src/hooks/usePlaybackQueueController.ts', 'src/App.tsx',
    'src/services/onlineMusic/audioPolicy.ts',
    'src/components/app/playback/restorePlaybackSource.ts', 'src/components/app/playback/createOnlineRecoveryController.ts',
    'src/hooks/useSessionRestoreController.ts', 'src/hooks/useElectronWindowPlaybackHandoff.ts',
    'electron/nativeAudio/hqplayerSpotifyExperiment.cjs', 'electron/nativeAudio/hqplayerStreamAdapter.cjs', 'electron/hqplayer/client.cjs',
    'electron/main.cjs', 'electron/preload.cjs', 'electron/private-preview.cjs', 'electron/privatePreview.cjs',
    'electron/debug/privatePreviewDiagnosticSchema.cjs', 'electron/debug/privatePreviewDiagnosticBus.cjs', 'electron/debug/privatePreviewJournal.cjs', 'electron/debug/privatePreviewDiagnostics.cjs',
    'electron/debug/pauseResponseInspection.cjs',
    'electron/nativeAudio/service.cjs', 'electron/nativeAudio/livePcmSession.cjs', 'electron/nativeAudio/livePcmFormat.cjs', 'electron/nativeAudio/streamSession.cjs',
    'electron/spotify/service.cjs', 'electron/spotify/soloistRuntime.cjs', 'electron/spotify/soloistOwnedAppliance.cjs',
    'electron/spotify/catalog.cjs', 'electron/spotify/catalogObservation.cjs', 'electron/spotify/errors.cjs',
    'electron/spotify/sessionVault.cjs', 'electron/spotify/officialTrackMetadata.cjs', 'electron/spotify/playlistCatalogDiagnostics.cjs', 'src/services/onlineMusic/spotifyLibraryDiagnostics.ts', 'electron/spotify/requestDiagnostics.cjs', 'electron/spotify/playlistDiagnostics.cjs',
    'electron/spotify/soloistAuthReadObserver.cjs', 'electron/spotify/soloistAuthDiagnostics.cjs', 'electron/spotify/soloistAudioPreparation.cjs',
    'electron/spotify/privatePreviewObserver.cjs',
    'electron/spotify/cableService.cjs', 'electron/spotify/cableSetup.cjs', 'electron/spotify/cableDiagnostics.cjs',
    'electron/spotify/ownedRouteHost.cjs', 'electron/spotify/ownedRouteLifecycle.cjs', 'electron/spotify/ownedRouteAudio.cjs',
    'electron/spotify/ownedRouteProtocol.cjs', 'electron/spotify/ownedRouteCleanup.cjs', 'electron/spotify/ownedRouteTrial.cjs', 'electron/spotify/nativeComponentPath.cjs',
    'electron/spotify/desktopColdBootstrap.cjs', 'electron/spotify/desktopColdRecovery.cjs', 'electron/spotify/desktopColdRecoveryAction.cjs',
    'electron/spotify/cableCaptureHost.cjs', 'electron/spotify/cableCaptureProtocol.cjs', 'electron/spotify/cablePcmQueue.cjs',
    'electron/spotify/cableAudioPreparation.cjs', 'electron/spotify/cableAudioFacts.cjs', 'electron/spotify/desktopPlaybackControl.cjs', 'electron/spotify/desktopPlaybackApi.cjs', 'electron/spotify/desktopPlaybackFacts.cjs',
    'src/components/modal/settings/SpotifyCableFields.tsx', 'src/services/onlineMusic/spotifyCableSetup.ts', 'src/services/onlineMusic/spotifyCableStatus.ts',
    'electron/spotify/soloistBrowserSession.cjs', 'electron/spotify/soloistHttpInvoke.cjs', 'electron/spotify/soloistPcmClient.cjs',
    'electron/spotify/soloistApplication.cjs', 'electron/spotify/soloistApplianceComposition.cjs', 'electron/spotify/soloistApplianceOwner.cjs', 'electron/spotify/soloistDiscovery.cjs',
    'electron/spotify/soloistControl.cjs', 'electron/spotify/soloistPcmPreparation.cjs', 'electron/spotify/soloistSetupHandler.cjs',
    'src/types/electron.d.ts', 'src/types/nativeAudio.ts', 'src/services/nativeAudioClient.ts',
    'src/vite-env.d.ts', 'src/types/privateDiagnostics.ts', 'src/services/debug/privateDiagnostics.ts',
    'src/services/onlineMusic/omni.ts', 'src/services/onlineMusic/providerPagination.ts', 'src/hooks/useSpotifyLibrary.ts', 'src/services/onlineMusic/spotifyProvider.ts', 'src/services/onlineMusic/spotifyNormalize.ts',
    'src/services/onlineMusic/spotifyTransport.ts', 'src/services/onlineMusic/spotifySavedTracks.ts',
    'src/hooks/usePrivateDiagnostics.ts', 'src/components/modal/settings/PrivateDiagnosticsSection.tsx',
    'src/components/modal/settings/DeveloperSettingsSubview.tsx', 'src/services/nativeAudio/outputHandoff.ts',
    'src/hooks/useOutputPlaybackHandoff.ts', 'src/services/nativeAudio/NativeAudioTransport.ts',
    'src/i18n/locales/en.ts', 'src/i18n/locales/zh-CN.ts', 'src/i18n/locales/in.ts',
    'packaging/exclusive/privateDevelopment.cjs', 'packaging/exclusive/private-development-entry.cjs',
    'packaging/exclusive/build-private-development.cjs', 'packaging/exclusive/private-development-installer.nsi',
    'package.json', 'package-lock.json',
    // Private r5 changed paths retained for diagnostic build attribution.
    'electron/nativeAudio/errors.cjs',
    'electron/nativeAudio/sourceInfo.cjs',
    'src/components/Grid3D.tsx',
    'src/components/app/home/SpotifyConnectionModal.tsx',
    'src/components/app/home/SpotifyConnectionSteps.tsx',
    'src/components/audio/HQPlayerSpotifyExperimentSettings.tsx',
    'src/components/audio/SignalPath.tsx',
    'src/components/audio/buildSignalPath.ts',
    'src/components/command-palette/commands/settingsCommands.ts',
    'src/components/modal/settings/HQPlayerSettingsSection.tsx',
    'src/components/modal/settings/SpotifyPlaybackKeyInput.tsx',
    'src/components/modal/settings/SpotifyPlaybackProgress.tsx',
    'src/components/modal/settings/SpotifyPlaybackSetup.tsx',
    'src/components/modal/settings/SpotifySettingsSection.tsx',
    'src/hooks/useNativeSignalPathEnabled.ts',
    'src/hooks/useOnlineProviderPlatform.ts',
    'src/hooks/useSpotifyConnection.ts',
    'src/services/nativeAudio/errors.ts',
    'src/services/nativeAudio/loadOnlineSource.ts',
    'src/services/onlineMusic/SoloistBrowserTransport.ts',
    'src/services/onlineMusic/spotifyConnectionSteps.ts',
    'src/services/onlineMusic/spotifyPlaybackSetup.ts',
    'src/services/repositories/cacheRepository.ts',
    'src/stores/useHQPlayerSettingsStore.ts',
    'src/stores/usePlaybackLoadStore.ts',
    'src/stores/useSpotifyConnectionStore.ts',
    'src/utils/hqplayerSpotifyExperiment.ts',
    // Private r10 metadata fallback and wizard appearance attribution.
    'electron/spotify/playlistMetadataRouting.cjs',
    'electron/spotify/publicPlaylistMetadata.cjs',
    'src/types/onlineMusic.ts',
    'src/components/GridView.tsx',
    'src/components/folia-grid/CollectionMetadataNotice.tsx',
    'src/components/folia-grid/onlineCollectionSync.ts',
    'src/components/folia-grid/PolaroidCard.tsx',
    'src/components/folia-grid/polaroidCardParts.tsx',
    'src/components/modal/settings/SpotifySetupAppearance.css',
    // Private r11 source artwork and viewport-safe wizard attribution.
    'electron/spotify/publicTrackArtwork.cjs',
    'src/components/folia-grid/SpotifyPublicArtwork.tsx',
    'src/components/app/home/useSpotifyPortalTheme.ts',
    'electron/nativeAudio/helper.cjs',
    'src/components/app/playback/PlaybackDeck.tsx',
    'src/components/app/playback/onlinePlaybackFailure.ts',
    'src/components/modal/settings/SpotifyColdRecoveryNotice.tsx',
    'src/hooks/useNativeAudioRecovery.ts',
    'src/services/nativeAudio/switchFromHQPlayer.ts',
    'src/stores/useAudioSettingsStore.ts',
]);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = value => typeof value === 'string' && /^\d{1,4}(?:\.\d{1,6}){2,3}(?:[-+][a-zA-Z0-9.-]{1,40})?$/.test(value);
function projectBuildInfo(value) {
    const result = {};
    for (const key of ['appVersion', 'electronVersion', 'nodeVersion', 'chromiumVersion']) {
        const candidate = own(value, key);
        if (version(candidate)) result[key] = candidate;
    }
    for (const [key, validate] of Object.entries({ platform: choices('win32 linux darwin'), arch: choices('x64 arm64 ia32'), channel: choices('private-preview') })) {
        const candidate = own(value, key); if (validate(candidate)) result[key] = candidate;
    }
    const buildId = own(value, 'buildId');
    if (typeof buildId === 'string' && /^\d{8}$/.test(buildId)) result.buildId = buildId;
    if (own(value, 'purpose') === 'private-development-only') result.purpose = 'private-development-only';
    for (const key of ['publicReleaseApproved', 'windowsExecutionTested']) if (own(value, key) === false) result[key] = false;
    const pin = own(value, 'soloistManifestSha256'); if (hash(pin)) result.soloistManifestSha256 = pin;
    for (const key of ['captureHelperSha256', 'bundledDriverSha256', 'routeHelperSha256']) { const digest = own(value, key); if (hash(digest)) result[key] = digest; }
    if (version(own(value, 'captureHelperVersion'))) result.captureHelperVersion = own(value, 'captureHelperVersion');
    if (version(own(value, 'routeHelperVersion'))) result.routeHelperVersion = own(value, 'routeHelperVersion');
    if (own(value, 'routeProductionQualified') === false) result.routeProductionQualified = false;
    if (own(value, 'routeValidationProfile') === 'folia-r19-owned-route-28000-x64-v1')
        result.routeValidationProfile = 'folia-r19-owned-route-28000-x64-v1';
    if (own(value, 'spotifyPlaybackBackend') === 'vb-cable') result.spotifyPlaybackBackend = 'vb-cable';
    const input = own(value, 'sourceHashes'), sources = {};
    for (const name of SOURCE_FILES) { const candidate = own(input, name); if (hash(candidate)) sources[name] = candidate; }
    if (Object.keys(sources).length) result.sourceHashes = Object.freeze(sources);
    return Object.freeze(result);
}
// Sorting recursively provides an identity independent of caller property order.
function canonical(value) {
    if (!object(value)) return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const buildReference = build => createHash('sha256').update(canonical(projectBuildInfo(build))).digest('hex');
const runUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function projectRecord(value) {
    if (!object(value)) return null;
    const event = projectEvent(own(value, 'type'), own(value, 'fields'));
    const timestamp = own(value, 'timestamp'), sequence = own(value, 'sequence'), runId = own(value, 'runId');
    const buildRef = own(value, 'buildRef');
    if (!event || !utc(timestamp) || !integer(Number.MAX_SAFE_INTEGER)(sequence) || sequence < 1 || !runUuid(runId) || !hash(buildRef)) return null;
    return { timestamp, sequence, runId, buildRef, ...event };
}
function sourceErrorCode(error) {
    const code = own(error, 'code');
    return errorCode(code) ? code : 'UNKNOWN';
}
module.exports = { own, projectEvent, projectConfigurationIssueCodes, projectFormatLeaseReadback, projectRecord, projectBuildInfo, buildReference, runUuid, sourceErrorCode, RENDERER_EVENTS, SOURCE_FILES, canonical };
