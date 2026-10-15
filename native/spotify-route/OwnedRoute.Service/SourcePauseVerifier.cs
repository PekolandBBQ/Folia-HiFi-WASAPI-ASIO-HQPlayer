// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using System;
using System.Linq;
using System.Diagnostics;
using System.Threading;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

public sealed class SourcePauseVerifier
{
	private readonly ISourcePlaybackControl control;
	private readonly ISessionObserver observer;
	private readonly IVerifiedSpotifyResolver resolver;
	private readonly PreparationObservationLedger observations;
	private readonly bool requireNativeQuiescence;
	private readonly bool observeCaptureBaseline;

	private readonly Func<DateTimeOffset> now;

	private static readonly TimeSpan Budget = TimeSpan.FromSeconds(2.0);

	private static readonly TimeSpan ReadBudget = TimeSpan.FromSeconds(6.0);

	private static readonly TimeSpan PauseBudget = TimeSpan.FromSeconds(12.0);

	public SourcePauseVerifier(ISourcePlaybackControl control, ISessionObserver observer, IVerifiedSpotifyResolver resolver, Func<DateTimeOffset>? clock = null, PreparationObservationLedger? preparationLedger = null, bool requireNativeQuiescence = true, bool observeCaptureBaseline = false)
	{
		this.control = control;
		this.observer = observer;
		this.resolver = resolver;
		this.requireNativeQuiescence = requireNativeQuiescence;
		this.observeCaptureBaseline = observeCaptureBaseline;
		observations = preparationLedger ?? new PreparationObservationLedger();
		now = clock ?? ((Func<DateTimeOffset>)(() => DateTimeOffset.UtcNow));
	}

	public PlaybackStatus RequirePaused(OwnedPlaybackTarget target)
	{
        if (target.RequirePausedHoldObservation && (!(target.RequirePcmStopped || target.RequireSeekParkEvidence) || !target.RequirePreparationObservation
            || target.PreparationPhase != "selected" || target.RequirePreparedSelection || target.PreparationSelectedSourceUri is not null
            || target.RestoreOperationId is not null || target.AllowChangedTrackPausedForRestore || target.AllowPreviousPaused))
            throw new RouteBlockedException("PREPARATION_OBSERVATION_FORBIDDEN");
		using IBoundSpotifyPolicy boundSpotifyPolicy = resolver.OpenVerified(target.Process);
		RequireIdentity(boundSpotifyPolicy, target.Process);
		PlaybackStatus playbackStatus = Read(target);
		if (!playbackStatus.EmptyPlayer && playbackStatus.IsPlaying != false)
		{
			throw new RouteBlockedException("SOURCE_NOT_PAUSED");
		}
		DateTimeOffset dateTimeOffset = now();
        // Process-loopback capture does not consume an endpoint's mix. Spotify's
        // paused render client may remain Active (including silent packets), so
        // that flag is not a pause prerequisite. Fresh source/identity/PCM and
        // receipt checks above and below remain authoritative. An empty player
        // still needs independent native quiescence for restoration.
        if (requireNativeQuiescence || playbackStatus.EmptyPlayer || observeCaptureBaseline)
        {
        // An empty Web API player is not a paused-device fact. Only this explicit
        // restore receipt can ask the native all-endpoint quiescence observer.
        var settling = Stopwatch.StartNew();
        SessionObservation sessionObservation;
        for (;;) {
            var remaining = Budget - settling.Elapsed;
            if (remaining <= TimeSpan.Zero) { ObserveFailure("pause-budget", null, dateTimeOffset); throw new RouteBlockedException("PAUSED_SOURCE_OBSERVATION_TIMEOUT"); }
		    sessionObservation = playbackStatus.EmptyPlayer
            ? (observer as IRestoreQuiescenceObserver ?? throw new RouteBlockedException("EMPTY_PLAYER_NATIVE_PROOF_REQUIRED"))
                .ObserveRestoreQuiescence(boundSpotifyPolicy, remaining)
            : observer.Observe(boundSpotifyPolicy, remaining);
		    RequireIdentity(boundSpotifyPolicy, target.Process);
            // Player pause may precede the Windows session becoming inactive.
            // Retry only a complete, current, same-process observation. Never
            // turn an incomplete or changed-identity scan into a paused proof.
            var invalidObservation = !sessionObservation.CompleteForProcess ? "PAUSED_SOURCE_SCAN_INCOMPLETE"
                : sessionObservation.Process != target.Process || sessionObservation.Sessions.Any(x => x.Process != target.Process) ? "PAUSED_SOURCE_PROCESS_MISMATCH"
                : sessionObservation.ObservedAtUtc < dateTimeOffset ? "PAUSED_SOURCE_OBSERVATION_STALE"
                : sessionObservation.ObservedAtUtc > now() ? "PAUSED_SOURCE_OBSERVATION_IN_FUTURE"
                : sessionObservation.Sessions.Any(x => string.IsNullOrWhiteSpace(x.SessionInstanceId)) ? "PAUSED_SOURCE_SESSION_ID_MISSING" : null;
            if (invalidObservation is not null)
            { ObserveFailure(invalidObservation, sessionObservation, dateTimeOffset); throw new RouteBlockedException(invalidObservation); }
            if (!requireNativeQuiescence && !playbackStatus.EmptyPlayer || !sessionObservation.Sessions.Any(x => x.Active)) break;
            if (playbackStatus.EmptyPlayer || Budget - settling.Elapsed < TimeSpan.FromMilliseconds(20))
            { ObserveFailure("still-active", sessionObservation, dateTimeOffset); throw new RouteBlockedException("PAUSED_SOURCE_SESSIONS_STILL_ACTIVE"); }
            Thread.Sleep(20);
        }
		RequireIdentity(boundSpotifyPolicy, target.Process);
		if (!sessionObservation.CompleteForProcess || sessionObservation.Process != target.Process || sessionObservation.ObservedAtUtc < dateTimeOffset || sessionObservation.ObservedAtUtc > now() || sessionObservation.Sessions.Any((RenderSession x) => x.Process != target.Process || (requireNativeQuiescence || playbackStatus.EmptyPlayer) && x.Active || string.IsNullOrWhiteSpace(x.SessionInstanceId)))
		{
			ObserveFailure("final-native-observation", sessionObservation, dateTimeOffset);
			throw new RouteBlockedException("PAUSED_SOURCE_OBSERVATION_INVALID");
		}
        }
		PlaybackStatus playbackStatus2 = Read(target, target.RequirePausedHoldObservation ? playbackStatus : null);
		if (!playbackStatus2.EmptyPlayer && playbackStatus2.IsPlaying != false)
		{
			throw new RouteBlockedException("SOURCE_RESUMED_DURING_PAUSE_PROOF");
		}
		if ((target.RequirePreparationObservation || target.RestoreOperationId != null) && !PreparationObservationLedger.SameReceipt(playbackStatus, playbackStatus2))
		{
			throw new RouteBlockedException("PREPARATION_OBSERVATION_CHANGED_DURING_SCAN");
		}
		RequireIdentity(boundSpotifyPolicy, target.Process);
		return playbackStatus;
	}

    // Preserve the exact rejection predicates in optional local diagnostics; no source identities are logged.
    private void ObserveFailure(string reason, SessionObservation? observation, DateTimeOffset requestedAt)
    {
        var logPath = Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
        if (string.IsNullOrWhiteSpace(logPath)) return;
        try { System.IO.File.AppendAllText(logPath, System.Text.Json.JsonSerializer.Serialize(new {
            at = now().ToUnixTimeMilliseconds(), stage = "route.paused-proof-rejected", reason,
            complete = observation?.CompleteForProcess, rows = observation?.Sessions.Length,
            active = observation?.Sessions.Count(x => x.Active),
            beforeRequestedMs = observation is null ? (double?)null : (requestedAt - observation.ObservedAtUtc).TotalMilliseconds,
            aheadOfNowMs = observation is null ? (double?)null : (observation.ObservedAtUtc - now()).TotalMilliseconds
        }) + Environment.NewLine); } catch { }
    }

	public void PauseOwnedForRecovery(OwnedPlaybackTarget target)
	{
		if (target.RequirePreparationObservation || target.PreparationPhase != null || target.RestoreOperationId != null || target.AllowChangedTrackPausedForRestore || target.AllowEmptyPlayerForRestore)
		{
			throw new RouteBlockedException("PREPARATION_OBSERVATION_FORBIDDEN");
		}
		using (IBoundSpotifyPolicy bound = resolver.OpenVerified(target.Process))
		{
			RequireIdentity(bound, target.Process);
			PlaybackStatus playbackStatus = Read(target);
			if (playbackStatus.IsPlaying == true)
			{
				if (string.IsNullOrWhiteSpace(target.TrackUri) || playbackStatus.TrackUri != target.TrackUri)
				{
					throw new RouteBlockedException("RECOVERY_PLAYBACK_OWNERSHIP_UNCONFIRMED");
				}
				control.PauseExactDevice(target.DeviceId, PauseBudget);
			}
			RequireIdentity(bound, target.Process);
		}
		RequirePaused(target);
	}

	private PlaybackStatus Read(OwnedPlaybackTarget target, PlaybackStatus? sameHoldReceipt = null)
	{
		if (string.IsNullOrWhiteSpace(target.DeviceId) || !target.Process.WellFormed)
		{
			throw new RouteBlockedException("SOURCE_TARGET_BINDING_REQUIRED");
		}
		DateTimeOffset dateTimeOffset = now();
		PlaybackStatus playbackStatus = control.ReadFresh(ReadBudget);
		// A whole-millisecond JS clock can straddle the native clock boundary.
		// Re-read once for this narrow discrepancy; retain the original request
		// bound and validate the replacement normally instead of accepting stale data.
		if (!target.RequirePreparationObservation && target.RestoreOperationId is null
		    && !PreparationObservationLedger.HasReceipt(playbackStatus))
		{
		    var delta = playbackStatus.ObservedAtUtc.ToUnixTimeMilliseconds() - dateTimeOffset.ToUnixTimeMilliseconds();
		    if (delta < 0 && delta >= -2)
		    {
		        Thread.Sleep(2);
		        playbackStatus = control.ReadFresh(ReadBudget);
		    }
		}

        if (playbackStatus.EmptyPlayer && (!target.AllowEmptyPlayerForRestore || target.RestoreOperationId is null
            || !target.RequirePcmStopped || target.RequirePreparationObservation || target.RequirePreparedSelection
            || target.PreparationPhase is not null || playbackStatus.IsPlaying is not null || playbackStatus.TrackUri is not null)
            || !playbackStatus.EmptyPlayer && playbackStatus.IsPlaying is null)
            throw new RouteBlockedException("EMPTY_PLAYER_RESTORE_SCOPE_INVALID");
        if (target.RequireSeekParkEvidence)
        {
            var expectedPark = target.SeekParkReceipt ?? throw new RouteBlockedException("SEEK_PARK_RECEIPT_INVALID");
            expectedPark.Validate(expectedPark.Session, expectedPark.Generation, expectedPark.SeekTransaction, now());
            if (playbackStatus.CaptureParkReceipt != expectedPark || playbackStatus.PcmStopped
                || target.RequirePcmStopped || target.RestoreOperationId is not null || target.AllowEmptyPlayerForRestore)
                throw new RouteBlockedException("SEEK_PARK_EVIDENCE_REQUIRED");
        }
        else if (playbackStatus.CaptureParkReceipt is not null) throw new RouteBlockedException("SEEK_PARK_EVIDENCE_FORBIDDEN");
		if (target.RequirePcmStopped && !playbackStatus.PcmStopped)
		{
			throw new RouteBlockedException("PCM_STOP_NOT_CONFIRMED");
		}
		if (playbackStatus.DeviceId != target.DeviceId || playbackStatus.ObservedAtUtc > now())
		{
			throw new RouteBlockedException("SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH");
		}
        if (target.RequirePausedHoldObservation && playbackStatus.TrackUri != target.TrackUri)
            throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
        if (sameHoldReceipt is not null && !PreparationObservationLedger.SameReceipt(sameHoldReceipt, playbackStatus))
            throw new RouteBlockedException("PREPARATION_OBSERVATION_CHANGED_DURING_SCAN");
		if (target.RestoreOperationId != null)
		{
			observations.ValidateRestore(target, playbackStatus, now());
		}
		else if (target.RequirePreparationObservation)
		{
			observations.Validate(target, playbackStatus, now());
		}
		else
		{
			if (PreparationObservationLedger.HasReceipt(playbackStatus) || target.PreparationPhase != null)
			{
				throw new RouteBlockedException("PREPARATION_OBSERVATION_FORBIDDEN");
			}
			// The JS broker stamps observations in whole Unix milliseconds. Compare at
			// that same precision; sub-millisecond native ticks cannot prove a stale read.
			if (playbackStatus.ObservedAtUtc.ToUnixTimeMilliseconds() < dateTimeOffset.ToUnixTimeMilliseconds())
			{
				throw new RouteBlockedException("SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH");
			}
		}
		if (target.RequirePreparedSelection && (!OwnedPlaybackTarget.IsSelectedSourceUri(target.PreparationSelectedSourceUri) || !(playbackStatus.PcmStopped || target.RequireSeekParkEvidence) || !playbackStatus.PreparationOwned || (playbackStatus.PlaybackRequestPending ?? true)))
		{
			throw new RouteBlockedException("PREPARED_SELECTION_PROOF_REQUIRED");
		}
		if (target.AllowChangedTrackPausedForRestore && (target.RestoreOperationId is null || !target.RequirePcmStopped
            || target.RequirePreparationObservation || target.RequirePreparedSelection || target.PreparationPhase is not null))
            throw new RouteBlockedException("PREPARATION_OBSERVATION_FORBIDDEN");
        if (!playbackStatus.EmptyPlayer && playbackStatus.TrackUri != target.TrackUri && !(target.AllowChangedTrackPausedForRestore && playbackStatus.IsPlaying == false && playbackStatus.PcmStopped)
            && (!target.AllowPreviousPaused || playbackStatus.IsPlaying != false || !(playbackStatus.TrackUri == target.PausedPreviousTrackUri)))
		{
			throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
		}
        if (playbackStatus.PausedProofTransferSuperseded)
            throw new RouteBlockedException(target.PausedProofTransferId is not null
                ? "PAUSED_PROOF_TRANSFER_SUPERSEDED" : "PREPARATION_OBSERVATION_FORBIDDEN");
		return playbackStatus;
	}

	private static void RequireIdentity(IBoundSpotifyPolicy bound, SpotifyProcess expected)
	{
		if (bound.Identity != expected || bound.CheckLiveIdentity() != expected)
		{
			throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
		}
	}
}
