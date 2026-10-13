# r19 automatic Spotify routing

This candidate integrates the long-lived native route service into Folia's existing Spotify control and CABLE PCM source. It does not invoke the A025 roundtrip CLI. The private validation profile is `folia-r19-owned-route-28000-x64-v1`; production qualification remains false.

## Admission

- Automatic routing is an internal part of a requested Spotify track. There is no user-facing routing mode or daily connect/verify step. Passive settings read inventory and component metadata without starting the route helper.
- Main accepts only the fixed profile, exact component length and SHA-256, supported single-file distribution, x64, and Windows 10.0.28000. Native independently verifies the reviewed OS/ABI profile. No environment variable or renderer-supplied profile can expand it.
- The handshake must provide all implementation, source ownership, retained recovery, coherent observation and interval isolation capabilities.
- First selection requires one saved acknowledgement of Spotify's own Audio output Default and disabling its exclusive output where present. There is no supported official API for these client settings. The old r18 explicit-VB acknowledgement is not silently reinterpreted. The new acknowledgement is stored at the profile top level, while the original six-field selection keeps its old acknowledgement false so r18 rollback remains readable and safe.
- Previously confirmed vendor InternalSR 44.1 kHz evidence remains required. A capture endpoint's 44.1 kHz mix format is not evidence of that separate vendor setting. The selected render/capture endpoints must be the verified ordinary Base VB pair. Other writers and default-device feedback remain blocked.
- Windows per-app Console and Multimedia originals may be null or independently verified safe explicit raw policies. Main binds the exact preflight strings to the lease and compensation receipt; no canonicalization or global-default write is allowed.
- If no native audio session exists, or the saved Connect target is inactive/has an empty player response, a controlled cold bootstrap verifies exact-target volume support and its original value, confirms volume zero, restores the explicitly saved target if needed, selects the requested track, discovers the actual audio process, then confirms pause/seek zero before restoring volume. GET 204 never proves pause. An initially active remote Connect device is observed before the user-requested transfer; changes after that baseline stop the operation. Ambiguous local identity is never guessed.

## Playback ordering

Preparation parks the exact selected desktop before changing its route. It acquires a temporary route, opens a native discard capture, arms the interval after the format lease has created its inactive session, then starts capture and requests a one-use resume permit. Spotify selection can briefly play only into that private capture. Full route proof follows; Spotify is paused and positioned, capture is stopped with acknowledgment, and exact app outputs are restored before the prepared source is published.

Cold bootstrap retains an interruption receipt before its volume mutation. Failed cleanup or an unresolved receipt after restart blocks playback rather than replaying stale grant/device authority. Its exceptional recovery panel shows only the saved desktop and original volume. An explicit recovery check uses fresh authorization, two consistent paused-source/original-volume observations and an unchanged bounded receipt before clearing that marker; it does not change Spotify volume, playback or routing. Normal successful playback requires no recovery action. API volume readback is not hardware silence proof; Windows validation must exercise this sequence, including cancellation and any unsupported volume target.

Each real read or resume creates a new route and capture generation:

1. Confirm the selected device, track and parked position.
2. Acquire the exact temporary route while source pause is independently verified.
3. Open capture in private buffer mode, including the existing 44.1 kHz stereo format lease.
4. Arm the native isolation interval once, after capture open and before capture start.
5. Start private capture, authorize resume, and confirm official Spotify Play.
6. Validate full active routing and the same intact interval; promote capture without dropping its prefix.
7. Validate that same interval again before main reads or publishes any PCM.

The original two-second queue limit remains. An overflow fails the generation; it never expands the queue or silently discards the start of a song. The native captured-frame watermark stays cumulative across promotion. Discard preparation can never be promoted. Normal capture continues to require its original route guard.

Interval evidence is retained across the entire buffered span. Foreign or unknown Base activity, coverage loss, stale process identity or interval replacement prevents delivery. Later playback continues to be checked; a successful observation is not a guarantee against future external writers.

## Cleanup and source proof

Pause, stop, cancellation, replacement, logout and service shutdown revoke main PCM publication before cleanup. Capture stop or own-child exit must be confirmed before route release. Original app-role strings, including null values, are compared exactly.

The native parent can request a fresh source read or exact-owned pause over its existing private command channel. Main validates the owned child, session, generation, device and approved source URI. The broker has a two-second request budget and retains only read/pause authority after normal playback revocation. It cannot play, seek, select or transfer, and a changed grant, device, URI or stale generation is rejected. This narrow path avoids enqueueing behind the preparation operation that is waiting for its proof.

Unconfirmed main Pause does not become a paused assertion. Native must independently establish quiescence before restoration and may use its bounded retained recovery. Main accepts only a full terminal receipt, or the native parent's explicit confirmed no-policy-writes receipt. An ambiguous failure blocks another lease. Source proof authority outlives native cleanup and is disposed afterward.

Failed acquisition preserves its original fixed rejection enum separately from terminal compensation evidence. Unknown exception detail, paths and policy strings are not public error codes. Confirmed no-write or restored failures leave the public helper available for a later explicit attempt with a fresh worker; they never automatically replay the failed song request.

The broker also reports `pcmStopped` from main's actual capture and publication state for the exact pending/held generation. No capture request yet, or a positively prepared but never-started capture, may report stopped. An unresolved open/start/stop cannot. Verified stop or exact helper exit plus a revoked publication gate can report stopped. Native compensation requires this evidence in addition to fresh source pause; caller assertions are never copied into it.

Terminal success distinguishes exact per-app restoration from observed system changes: `exactOriginalRolesRestored: true`, `globalDefaultsWritten: false`, and a separate `observedDefaultsChanged` fact. An OS-driven switch between physical defaults, such as an exclusive-output transition, is recorded without making Folia write global or communications defaults to force an old value.

Normal quit is blocked with a visible explanation if owned routing cleanup or helper exit is unconfirmed. A successful close receipt followed by a nonzero or signal exit is not a clean shutdown.

## Validation limits

Cloud validation covers real product orchestration with mocked external boundaries, the actual managed negative handshake, native device-free tests and Windows-target cross-compilation. These checks do not constitute Windows routing, real Spotify, hardware output, driver or audio-quality acceptance. The complete candidate is intended for one combined local validation after all components and recovery receipts have been reviewed together.

Entry points: `electron/spotify/cableService.cjs`, `ownedRouteHost.cjs`, `ownedRouteLifecycle.cjs`, `ownedRouteAudio.cjs`, `cableAudioPreparation.cjs`, and `desktopPlaybackControl.cjs`. Native route and capture sources accompany the candidate separately. Route bytes are verified against the fixed component manifest; capture uses the pinned package path and mandatory native protocol checks. Both executables are unpacked for ASAR builds.
