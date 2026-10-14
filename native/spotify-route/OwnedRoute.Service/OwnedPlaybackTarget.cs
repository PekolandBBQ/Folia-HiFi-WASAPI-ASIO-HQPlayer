// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using System;
using System.Linq;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

public sealed record OwnedPlaybackTarget(string DeviceId, string? TrackUri, SpotifyProcess Process, string? PausedPreviousTrackUri = null, bool AllowPreviousPaused = false, bool RequirePcmStopped = false, bool RequirePreparedSelection = false, string? PreparationSelectedSourceUri = null, bool RequirePreparationObservation = false, string? PreparationPhase = null, string? RestoreOperationId = null, DateTimeOffset? RestoreStartedAtUtc = null, bool AllowChangedTrackPausedForRestore = false, bool RequirePausedHoldObservation = false, bool AllowEmptyPlayerForRestore = false, string? PausedProofTransferId = null, string? ResumeIntentId = null, bool PausedProofTransferFallback = false, bool RequireSeekParkEvidence = false, OwnedSeekParkReceipt? SeekParkReceipt = null, int SourceEpoch = 1)
{
	public OwnedPlaybackTarget ForFreshRecovery()
	{
		return this with
		{
			RequirePcmStopped = true,
			RequirePreparedSelection = false,
			PreparationSelectedSourceUri = null,
			RequirePreparationObservation = false,
			PreparationPhase = null,
			RestoreOperationId = null,
			RestoreStartedAtUtc = null,
            AllowChangedTrackPausedForRestore = false,
            RequirePausedHoldObservation = false,
            AllowEmptyPlayerForRestore = false,
            PausedProofTransferId = null, ResumeIntentId = null, PausedProofTransferFallback = false, RequireSeekParkEvidence = false, SeekParkReceipt = null
		};
	}

	public static bool IsSelectedSourceUri(string? value)
	{
		if (value != null && value.Length == 36 && value.StartsWith("spotify:track:", StringComparison.Ordinal))
		{
			return value.Skip(14).All(char.IsAsciiLetterOrDigit);
		}
		return false;
	}
}
