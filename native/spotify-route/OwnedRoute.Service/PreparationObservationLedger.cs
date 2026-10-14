// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using System;
using System.Collections.Generic;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

public sealed class PreparationObservationLedger
{
	public static readonly TimeSpan MaximumAge = TimeSpan.FromSeconds(5.0);

	private PlaybackStatus? last;
    private OwnedPlaybackTarget? lastTarget;
    private sealed record KeeperRebind(OwnedPlaybackTarget Target, PlaybackStatus Receipt, OwnedSeekParkReceipt Park);
    private KeeperRebind? pendingKeeperRebind;

	private PlaybackStatus? restore;
    private PlaybackStatus? resumeFloor;
    // A new preparation phase may return selected -> baseline only through this
    // explicit same-owner transition. Monotonic observation/mutation floors remain.
    public static readonly TimeSpan TransferMaximumAge = TimeSpan.FromMilliseconds(500);
    private sealed record Transfer(string Id, OwnedPlaybackTarget Target, PlaybackStatus Receipt);
    private Transfer? offeredTransfer, activeTransfer;
    private string? activeIntent;

    // Only a completed native held-pause proof can offer this exact receipt once.
    public bool IssuePausedProofTransfer(string id, OwnedPlaybackTarget target, DateTimeOffset now)
    {
        offeredTransfer = null; activeTransfer = null; activeIntent = null;
        if (!Guid.TryParseExact(id, "D", out _) || !target.RequirePausedHoldObservation
            || last is not { IsPlaying: false, PreparationPhase: "selected" } receipt
            || !(receipt.PcmStopped || target.RequireSeekParkEvidence && receipt.CaptureParkReceipt == target.SeekParkReceipt)
            || receipt.DeviceId != target.DeviceId || receipt.TrackUri != target.TrackUri
            || receipt.ObservedAtUtc > now || now - receipt.ObservedAtUtc >= TransferMaximumAge) return false;
        offeredTransfer = new(id, target, receipt);
        return true;
    }

    public void BeginResumePreparation(string id, string intent)
    {
        var transfer = offeredTransfer;
        offeredTransfer = null; activeTransfer = null; activeIntent = null;
        if (transfer?.Id != id || !Guid.TryParseExact(intent, "D", out _))
            throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_INVALID");
        BeginResumePreparation();
        activeTransfer = transfer; activeIntent = intent;
    }

    public void FinishPausedProofTransfer() { offeredTransfer = null; activeTransfer = null; activeIntent = null; pendingKeeperRebind = null; }

    // Native-only transition, called after the retained live keeper has accepted
    // the fresh capture generation. It retires capture evidence, never a source
    // observation. The next source read must preserve every original source fact.
    public void AuthorizeSeekKeeperRebind(OwnedSeekParkReceipt park, OwnedSilentRenderLeaseProof previous,
        OwnedSilentRenderLeaseProof next, DateTimeOffset now)
    {
        pendingKeeperRebind = null;
        park.Validate(previous.CaptureSession, previous.CaptureGeneration, park.SeekTransaction, now);
        previous.RequireSeekRebind(next);
        if (last is not { IsPlaying: false, PreparationPhase: "selected" } receipt || receipt.CaptureParkReceipt != park
            || lastTarget is not { RequireSeekParkEvidence: true, RequirePreparedSelection: true,
                RequirePreparationObservation: true, PreparationPhase: "selected" } target
            || target.SeekParkReceipt != park || target.PausedProofTransferId is not null
            || target.DeviceId != receipt.DeviceId || target.TrackUri != receipt.TrackUri
            || receipt.ObservedAtUtc > now || now - receipt.ObservedAtUtc > MaximumAge)
            throw new RouteBlockedException("SEEK_PARK_REBIND_OBSERVATION_INVALID");
        pendingKeeperRebind = new(target with { RequirePcmStopped = false, RequirePreparedSelection = false,
            PreparationSelectedSourceUri = null, RequireSeekParkEvidence = false, SeekParkReceipt = null }, receipt, park);
    }

    public void BeginResumePreparation()
    {
        FinishPausedProofTransfer();
        resumeFloor = last ?? resumeFloor;
        last = null;
    }

	private readonly HashSet<string> retiredRestoreIds = new HashSet<string>(StringComparer.Ordinal);

	public static bool HasReceipt(PlaybackStatus value)
	{
		if (!value.ObservationGeneration.HasValue && !value.MutationEpoch.HasValue && value.PreparationPhase == null && !value.PositionMs.HasValue)
		{
			return value.RestoreOperationId != null;
		}
		return true;
	}

	public static bool SameReceipt(PlaybackStatus a, PlaybackStatus b)
	{
		if (a.CaptureParkReceipt == b.CaptureParkReceipt && a.ObservationGeneration == b.ObservationGeneration && a.MutationEpoch == b.MutationEpoch && a.PreparationPhase == b.PreparationPhase && a.PositionMs == b.PositionMs && a.RestoreOperationId == b.RestoreOperationId && a.ObservedAtUtc == b.ObservedAtUtc && a.DeviceId == b.DeviceId && a.TrackUri == b.TrackUri)
		{
			return a.IsPlaying == b.IsPlaying && a.EmptyPlayer == b.EmptyPlayer;
		}
		return false;
	}

	public void Validate(OwnedPlaybackTarget target, PlaybackStatus value, DateTimeOffset now)
    {
        var rebound = pendingKeeperRebind;
        pendingKeeperRebind = null;
        if (rebound is not null)
        {
            rebound.Park.Validate(rebound.Park.Session, rebound.Park.Generation, rebound.Park.SeekTransaction, now);
            if (target != rebound.Target || last != rebound.Receipt
                || !SameReceipt(rebound.Receipt with { CaptureParkReceipt = null }, value))
                throw new RouteBlockedException("SEEK_PARK_REBIND_OBSERVATION_INVALID");
        }
        if (target.PausedProofTransferId is not null)
        {
            var transfer = activeTransfer;
            if (transfer?.Id != target.PausedProofTransferId || activeIntent != target.ResumeIntentId
                || target.DeviceId != transfer.Target.DeviceId || target.TrackUri != transfer.Target.TrackUri
                || target.Process != transfer.Target.Process || target.SourceEpoch != transfer.Target.SourceEpoch || target.PreparationPhase != "selected"
                || !(target.RequirePcmStopped || target.RequireSeekParkEvidence) || !target.RequirePreparedSelection || !target.RequirePreparationObservation
                || target.RequirePausedHoldObservation || target.RestoreOperationId is not null
                || target.AllowPreviousPaused || target.AllowChangedTrackPausedForRestore || target.AllowEmptyPlayerForRestore
                || target.PreparationSelectedSourceUri != target.TrackUri || !SameReceipt(transfer.Receipt, value)
                || !(value.PcmStopped || target.RequireSeekParkEvidence && value.CaptureParkReceipt == target.SeekParkReceipt) || !value.PreparationOwned || value.PlaybackRequestPending != false
                || value.IsPlaying != false || value.EmptyPlayer)
                throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_INVALID");
            if (value.ObservedAtUtc > now || now - value.ObservedAtUtc >= TransferMaximumAge)
                throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_EXPIRED");
            last = value; lastTarget = target;
            return;
        }
        if (last is null && resumeFloor is not null && (value.ObservationGeneration <= resumeFloor.ObservationGeneration
            || value.MutationEpoch <= resumeFloor.MutationEpoch))
            throw new RouteBlockedException("PREPARATION_OBSERVATION_REPLAYED");
		bool flag = value.RestoreOperationId != null || target.RestoreOperationId != null;
		if (!flag)
		{
			string preparationPhase = target.PreparationPhase;
			bool flag2 = ((preparationPhase == "baseline" || preparationPhase == "selected") ? true : false);
			flag = !flag2;
		}
		if (!flag && !(value.PreparationPhase != target.PreparationPhase))
		{
			long? observationGeneration = value.ObservationGeneration;
			if (observationGeneration.HasValue)
			{
				long valueOrDefault = observationGeneration.GetValueOrDefault();
				if (valueOrDefault >= 1 && valueOrDefault <= 9007199254740991L)
				{
					observationGeneration = value.MutationEpoch;
					if (observationGeneration.HasValue)
					{
						valueOrDefault = observationGeneration.GetValueOrDefault();
						if (valueOrDefault >= 0 && valueOrDefault <= 9007199254740991L)
						{
							observationGeneration = value.PositionMs;
							if (observationGeneration.HasValue)
							{
								valueOrDefault = observationGeneration.GetValueOrDefault();
								if (valueOrDefault >= 0 && valueOrDefault <= 9007199254740991L && value.PreparationOwned)
								{
									bool? playbackRequestPending = value.PlaybackRequestPending;
									if (playbackRequestPending.HasValue && playbackRequestPending != true && value.IsPlaying == false && !value.EmptyPlayer && !(value.ObservedAtUtc > now) && (target.RequirePausedHoldObservation || !(now - value.ObservedAtUtc > MaximumAge)))
									{
										PlaybackStatus playbackStatus = last;
										if ((object)playbackStatus != null && (value.ObservationGeneration < playbackStatus.ObservationGeneration || value.MutationEpoch < playbackStatus.MutationEpoch || (value.ObservationGeneration == playbackStatus.ObservationGeneration && !SameReceipt(playbackStatus, value) && rebound is null) || (playbackStatus.PreparationPhase == "selected" && value.PreparationPhase != "selected") || (playbackStatus.PreparationPhase != value.PreparationPhase && (value.ObservationGeneration <= playbackStatus.ObservationGeneration || value.MutationEpoch <= playbackStatus.MutationEpoch))))
										{
											throw new RouteBlockedException("PREPARATION_OBSERVATION_REPLAYED");
										}
                                        // Only the dedicated hold transaction can distinguish TTL from
                                        // invalid evidence. Expiry never installs a refreshed receipt.
                                        if (target.RequirePausedHoldObservation && now - value.ObservedAtUtc >= MaximumAge)
                                            throw new RouteBlockedException("PAUSED_HOLD_OBSERVATION_EXPIRED");
										last = value; lastTarget = target;
										return;
									}
								}
							}
						}
					}
				}
			}
		}
		throw new RouteBlockedException("PREPARATION_OBSERVATION_INVALID");
	}

    public void ValidateRestore(OwnedPlaybackTarget target, PlaybackStatus value, DateTimeOffset now)
    {
        pendingKeeperRebind = null;
        var empty = value.EmptyPlayer;
        if (target.RequirePreparationObservation || target.RequirePreparedSelection || target.PreparationPhase is not null
            || !Guid.TryParseExact(target.RestoreOperationId, "D", out _) || value.RestoreOperationId != target.RestoreOperationId
            || target.RestoreStartedAtUtc is not { } started || started > now || value.ObservedAtUtc < started
            || value.PreparationPhase is not null || value.ObservationGeneration is not (>= 1 and <= 9007199254740991L)
            || value.MutationEpoch is not (>= 0 and <= 9007199254740991L)
            || value.PlaybackRequestPending != false || value.ObservedAtUtc > now || now - value.ObservedAtUtc > MaximumAge
            || (empty ? !target.AllowEmptyPlayerForRestore || !target.RequirePcmStopped || value.IsPlaying is not null
                || value.TrackUri is not null || value.PositionMs is not null || value.PreparationOwned
                : value.PositionMs is not (>= 0 and <= 9007199254740991L)))
            throw new RouteBlockedException("RESTORE_OBSERVATION_INVALID");
        if (!value.PcmStopped) throw new RouteBlockedException("PCM_STOP_NOT_CONFIRMED");
        if (!empty && value.IsPlaying != false) throw new RouteBlockedException("SOURCE_NOT_PAUSED");
        if (restore?.RestoreOperationId == value.RestoreOperationId)
        {
            if (!SameReceipt(restore, value)) throw new RouteBlockedException("RESTORE_OBSERVATION_CHANGED");
            return;
        }
        if (retiredRestoreIds.Contains(value.RestoreOperationId)
            || restore is not null && (value.ObservationGeneration <= restore.ObservationGeneration || value.MutationEpoch < restore.MutationEpoch)
            || last is not null && (value.ObservationGeneration <= last.ObservationGeneration || value.MutationEpoch < last.MutationEpoch))
            throw new RouteBlockedException("RESTORE_OBSERVATION_REPLAYED");
        if (restore?.RestoreOperationId is { } prior) retiredRestoreIds.Add(prior);
        if (retiredRestoreIds.Count > 128) throw new RouteBlockedException("RESTORE_OBSERVATION_INVALID");
        restore = value;
    }
}
