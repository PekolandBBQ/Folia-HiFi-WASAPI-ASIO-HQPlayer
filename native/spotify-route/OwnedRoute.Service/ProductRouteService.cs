// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

public sealed class ProductRouteService : IDisposable
{
	private sealed class AckJournal(IDurableRouteJournal journal, Action<RouteRecord> onAppend) : IDurableRouteJournal
	{
		public RouteRecord? ReadLatest()
		{
			return journal.ReadLatest();
		}

		public void Append(RouteRecord record)
		{
			journal.Append(record);
			onAppend(record);
		}
	}

	private sealed class OwnedResolver(IVerifiedSpotifyResolver resolver, Action beforeWrite) : IVerifiedSpotifyResolver
	{
		private sealed class OwnedBound(IBoundSpotifyPolicy bound, Action beforeWrite) : IBoundSpotifyPolicy, IDisposable
		{
			public SpotifyProcess Identity => bound.Identity;

			public SpotifyProcess CheckLiveIdentity()
			{
				return bound.CheckLiveIdentity();
			}

			public string? Get(RenderRole role)
			{
				return bound.Get(role);
			}

			public void Set(RenderRole role, string? endpoint)
			{
				if ((uint)role > 1u)
				{
					throw new RouteBlockedException("ROLE_OUTSIDE_PRODUCT_SCOPE");
				}
				beforeWrite();
				bound.Set(role, endpoint);
				beforeWrite();
			}

			public void Dispose()
			{
				bound.Dispose();
			}
		}

		public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected)
		{
			return new OwnedBound(resolver.OpenVerified(expected), beforeWrite);
		}
	}

	private readonly IProductRouteBackend backend;

	private readonly Func<DateTimeOffset> now;

	private readonly Func<TimeSpan> monotonic;

	private readonly object gate;

	private IProductRouteLifetime? lifetime;

	private OwnedRouteTransaction? transaction;

	private PreparedRetention? retention;

	private ProductDiscovery? discovery;

	private OwnedPlaybackTarget? playbackTarget;

	private OwnedPlaybackTarget? preparedSelectionTarget;

	private bool preparedSelectionCompleted;
    private PreparedTargetActivityWitness? preparedTargetActivity, completedTargetActivity;

	private string? session;

	private string? leaseId;

	private int generation;

	private bool resumeAuthorized;
    private string? pausedProofTransferId;
    private int pausedProofTransferEpoch;
    private OwnedSeekParkReceipt? seekParkReceipt;
    private string? seekRouteToken;
    private TimeSpan seekParkDeadline;
    private bool seekParked;
    private bool pausedHeld;
    private int intervalEpoch;
    private long lastCaptureGeneration;

	private bool closed;

	private bool journalFailed;

	private bool restoreAttempted;

	private TimeSpan lastContact;

	private ServiceReply? lastRelease;

	public static readonly TimeSpan IdleLimit = TimeSpan.FromSeconds(15.0);

	public bool Closed
	{
		get
		{
			lock (gate)
			{
				return closed;
			}
		}
	}

	public bool HasLease
	{
		get
		{
			lock (gate)
			{
				return lifetime != null;
			}
		}
	}

	public ProductRouteService(IProductRouteBackend backend, Func<DateTimeOffset>? clock = null, Func<TimeSpan>? elapsed = null)
	{
		this.backend = backend;
		now = clock ?? ((Func<DateTimeOffset>)(() => DateTimeOffset.UtcNow));
		monotonic = elapsed ?? ((Func<TimeSpan>)(() => Stopwatch.GetElapsedTime(0L)));
		gate = new object();
	}

	public ServiceReply Dispatch(string line)
	{
		lock (gate)
		{
			object obj = null;
			try
			{
				if (closed)
				{
					return Reply(obj, ok: false, "closed", "SERVICE_CLOSED");
				}
				using JsonDocument jsonDocument = JsonDocument.Parse(line, new JsonDocumentOptions
				{
					MaxDepth = 16
				});
				JsonElement rootElement = jsonDocument.RootElement;
				if (rootElement.ValueKind != JsonValueKind.Object)
				{
					throw new InvalidDataException("INVALID_REQUEST");
				}
				Unique(rootElement);
				if (!rootElement.TryGetProperty("id", out var value))
				{
					throw new InvalidDataException("REQUEST_ID_REQUIRED");
				}
				JsonValueKind valueKind = value.ValueKind;
				object obj2;
				if (valueKind != JsonValueKind.String)
				{
					if (valueKind == JsonValueKind.Number && value.TryGetInt64(out var value2) && value2 > 0)
					{
						obj2 = value2;
						goto IL_00f9;
					}
				}
				else
				{
					string text = value.GetString();
					if (text != null)
					{
						int length = text.Length;
						if (length > 0 && length <= 128)
						{
							obj2 = text;
							goto IL_00f9;
						}
					}
				}
				throw new InvalidDataException("REQUEST_ID_INVALID");
				IL_00f9:
				obj = obj2;
				string text2 = OptionalText(rootElement, "command") ?? OptionalText(rootElement, "action") ?? throw new InvalidDataException("COMMAND_REQUIRED");
				if (rootElement.TryGetProperty("command", out var value3) && rootElement.TryGetProperty("action", out value3))
				{
					throw new InvalidDataException("AMBIGUOUS_COMMAND_ENVELOPE");
				}
				JsonElement value4;
				JsonElement jsonElement = (rootElement.TryGetProperty("payload", out value4) ? value4 : JsonSerializer.SerializeToElement(new { }));
				if (jsonElement.ValueKind != JsonValueKind.Object)
				{
					throw new InvalidDataException("INVALID_PAYLOAD");
				}
				Unique(jsonElement);
				if (lifetime != null && monotonic() - lastContact >= IdleLimit)
				{
					return ShutdownLocked(obj, "OWNER_HEARTBEAT_EXPIRED");
				}
				switch (text2)
				{
				case "hello":
				case "capabilities":
				{
					if (jsonElement.TryGetProperty("protocolMajor", out var value5) && value5.GetInt32() != 1)
					{
						throw new RouteBlockedException("PROTOCOL_VERSION_UNSUPPORTED");
					}
					return Reply(obj, ok: true, backend.Capabilities.Supported ? "idle" : "unsupported", "CAPABILITIES", ready: false, caps: true);
				}
				case "inspect":
				{
					RequireCapability();
					RouteSelection routeSelection = Selection(jsonElement);
					ProductDiscovery productDiscovery = backend.Inspect(routeSelection);
					RequireDiscovery(productDiscovery, routeSelection);
					return Reply(obj, ok: true, "inspected", "INSPECTED", ready: false, caps: false, productDiscovery.ToWire());
				}
                case "validateHeld":
                {
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.ProviderRouteLifetime || !pausedHeld || seekParked
                        || resumeAuthorized || lifetime.IntervalId is not null || lifetime.IntervalGeneration != 0
                        || PositiveInteger(jsonElement, "intervalEpoch") != intervalEpoch
                        || Selection(jsonElement) != discovery.Selection
                        || Text(jsonElement, "sourceDeviceId") != playbackTarget.DeviceId)
                        throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    var retained = ValidateOwnershipAndPolicy();
                    if (retained.Stage != RouteStage.HeldPaused) return StageReply(obj, retained);
                    lastContact = monotonic();
                    return Reply(obj, true, "pausedHeld", "HELD_ROUTE_VALIDATED");
                }
                case "rebindPreparedSelection":
                {
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.ProviderRouteLifetime || !backend.Capabilities.PreparedSelection
                        || !backend.Capabilities.BoundedPreparationObservation || !backend.Capabilities.PreparedTargetActivity
                        || !pausedHeld || seekParked || resumeAuthorized || preparedSelectionTarget is not null
                        || lifetime.IntervalId is not null || lifetime.IntervalGeneration != 0)
                        throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    var nextEpoch = PositiveInteger(jsonElement, "intervalEpoch");
                    if (intervalEpoch == int.MaxValue || nextEpoch != intervalEpoch + 1)
                        throw new RouteBlockedException("CAPTURE_INTERVAL_EPOCH_MISMATCH");
                    var sourceEpoch = PositiveInteger(jsonElement, "sourceEpoch");
                    if (playbackTarget.SourceEpoch == int.MaxValue || sourceEpoch != playbackTarget.SourceEpoch + 1)
                        throw new RouteBlockedException("SOURCE_EPOCH_MISMATCH");
                    var previous = Text(jsonElement, "pausedSourceUri");
                    var selected = Text(jsonElement, "selectedSourceUri");
                    if (previous != playbackTarget.TrackUri || !OwnedPlaybackTarget.IsSelectedSourceUri(selected))
                        throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
                    if (OptionalText(jsonElement, "pausedProofTransferId") is not null
                        || OptionalText(jsonElement, "resumeIntentId") is not null)
                        throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_INVALID");
                    var retained = ValidateOwnershipAndPolicy();
                    if (retained.Stage != RouteStage.HeldPaused) return StageReply(obj, retained);
                    // A track boundary retires all earlier track evidence, even
                    // for a repeat of the same URI. Original routing never changes.
                    InvalidatePausedProofTransfer();
                    preparedTargetActivity = completedTargetActivity = null;
                    lifetime.BeginResumePreparation();
                    var baseline = playbackTarget.ForFreshRecovery() with {
                        RequirePcmStopped = true, RequirePreparedSelection = true,
                        PreparationSelectedSourceUri = selected,
                        RequirePreparationObservation = true, PreparationPhase = "baseline", SourceEpoch = sourceEpoch };
                    lifetime.VerifyPausedSource(baseline);
                    retained = ValidateOwnershipAndPolicy();
                    if (retained.Stage != RouteStage.HeldPaused) return StageReply(obj, retained);
                    preparedSelectionTarget = baseline with { TrackUri = selected,
                        PausedPreviousTrackUri = previous == selected ? null : previous,
                        AllowPreviousPaused = previous != selected };
                    playbackTarget = baseline;
                    preparedSelectionCompleted = false;
                    intervalEpoch = nextEpoch; pausedHeld = false; lastContact = monotonic();
                    return Reply(obj, true, "preparedSelection", "TRACK_PREPARATION_AUTHORIZED") with {
                        PreparedSelectionAuthorized = true, PreparedTargetActive = false };
                }
				case "acquire":
					return Acquire(obj, jsonElement);
				case "authorizePreparedSelection":
				{
					RequireLease(jsonElement);
					if (!backend.Capabilities.PreparedSelection)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_UNSUPPORTED");
					}
					if (resumeAuthorized || (object)preparedSelectionTarget != null || preparedSelectionCompleted || lifetime.IntervalGeneration != 0 || lifetime.IntervalId != null)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_INVALID_STATE");
					}
					RouteRecord routeRecord4 = ValidateOwnershipAndPolicy();
					if (routeRecord4.Stage != RouteStage.HeldPaused)
					{
						return StageReply(obj, routeRecord4);
					}
					string text4 = Text(jsonElement, "selectedSourceUri");
					if (!OwnedPlaybackTarget.IsSelectedSourceUri(text4))
					{
						throw new RouteBlockedException("SOURCE_URI_INVALID");
					}
					lifetime.VerifyPausedSource(playbackTarget with
					{
						RequirePcmStopped = true,
						RequirePreparedSelection = true,
						PreparationSelectedSourceUri = text4
					});
					lifetime.ValidateApplyAuthority();
					lifetime.ValidateOwnership(RequireRetention());
                    preparedTargetActivity = completedTargetActivity = null;
					preparedSelectionTarget = playbackTarget with
					{
						TrackUri = text4,
						PausedPreviousTrackUri = ((playbackTarget.TrackUri == text4) ? null : playbackTarget.TrackUri),
						AllowPreviousPaused = (playbackTarget.TrackUri != text4)
					};
					lastContact = monotonic();
					return Reply(obj, ok: true, "preparedSelection", "PREPARED_SELECTION_AUTHORIZED")with
					{
						PreparedSelectionAuthorized = true
					};
				}
                case "verifyPreparedTargetActive":
                {
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.PreparedTargetActivity)
                        throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_UNSUPPORTED");
                    if (preparedSelectionTarget is null || preparedSelectionCompleted || resumeAuthorized || pausedHeld ||
                        lifetime.IntervalGeneration != 0 || lifetime.IntervalId is not null ||
                        PositiveInteger(jsonElement, "intervalEpoch") != intervalEpoch ||
                        Text(jsonElement, "selectedSourceUri") != preparedSelectionTarget.TrackUri)
                        throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_INVALID_STATE");
                    preparedTargetActivity = null;
                    var route = ValidateOwnershipAndPolicy();
                    if (route.Stage != RouteStage.HeldPaused) return StageReply(obj, route);
                    var timer = Stopwatch.StartNew();
                    var budget = TimeSpan.FromSeconds(2);
                    SessionObservation observation;
                    // Complete but not-yet-migrated sessions may settle within this
                    // one read-only window. Incomplete/foreign/identity failures never retry.
                    for (;;)
                    {
                        var remaining = budget - timer.Elapsed;
                        if (remaining <= TimeSpan.Zero) throw new RouteBlockedException("SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET");
                        try { observation = transaction.ObserveHeldTargetActivity(remaining); break; }
                        catch (RouteBlockedException error) when (error.Message == "SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET")
                        {
                            if (timer.Elapsed >= budget) throw;
                            System.Threading.Thread.Sleep((int)Math.Min(25, Math.Max(1, (budget - timer.Elapsed).TotalMilliseconds)));
                        }
                    }
                    // ObserveHeldTargetActivity checks the bound process, endpoint and
                    // applied policy both before and after its fresh session scan.
                    // Do not repeat that scan or age the evidence from before it existed.
                    lifetime.ValidateApplyAuthority(); lifetime.ValidateOwnership(RequireRetention());
                    if (now() - observation.ObservedAtUtc >= budget) throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_EXPIRED");
                    preparedTargetActivity = new(route.TransactionId, leaseId!, generation, route.CurrentProcess,
                        preparedSelectionTarget.TrackUri!, route.Target.Id, intervalEpoch, observation.ObservedAtUtc,
                        observation.Sessions.Where(row => row.Active).Select(row => row.SessionInstanceId).ToArray());
                    lastContact = monotonic();
                    return Reply(obj, true, "preparedSelection", "PREPARED_TARGET_ACTIVE") with { PreparedTargetActive = true };
                }
				case "completePreparedSelection":
				{
					RequireLease(jsonElement);
                    if (backend.Capabilities.PreparedTargetActivity && PositiveInteger(jsonElement, "intervalEpoch") != intervalEpoch)
                        throw new RouteBlockedException("CAPTURE_INTERVAL_EPOCH_MISMATCH");
					if ((object)preparedSelectionTarget == null || resumeAuthorized || preparedSelectionCompleted || lifetime.IntervalGeneration != 0 || lifetime.IntervalId != null)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_INVALID_STATE");
					}
					RouteRecord routeRecord = ValidateOwnershipAndPolicy();
					if (routeRecord.Stage != RouteStage.HeldPaused)
					{
						return StageReply(obj, routeRecord);
					}
					OwnedPlaybackTarget ownedPlaybackTarget = preparedSelectionTarget with
					{
						PausedPreviousTrackUri = null,
						AllowPreviousPaused = false,
						RequirePcmStopped = !preparedSelectionTarget.RequireSeekParkEvidence,
						RequirePreparedSelection = true,
						PreparationSelectedSourceUri = preparedSelectionTarget.TrackUri,
						PreparationPhase = (playbackTarget.RequirePreparationObservation ? "selected" : null)
					};
                    if (backend.Capabilities.PreparedTargetActivity &&
                        preparedTargetActivity?.Matches(routeRecord, leaseId!, generation, ownedPlaybackTarget.TrackUri!, intervalEpoch) != true)
                        throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_REQUIRED");
					lifetime.VerifyPausedSource(ownedPlaybackTarget);
					lifetime.ValidateApplyAuthority();
					lifetime.ValidateOwnership(RequireRetention());
                    // Only a successful paused fence can consume active history.
                    if (backend.Capabilities.PreparedTargetActivity)
                    {
                        var afterPause = ValidateOwnershipAndPolicy();
                        if (afterPause.Stage != RouteStage.HeldPaused) return StageReply(obj, afterPause);
                        if (preparedTargetActivity?.Matches(afterPause, leaseId!, generation, ownedPlaybackTarget.TrackUri!, intervalEpoch) != true)
                            throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_REQUIRED");
                        completedTargetActivity = preparedTargetActivity; preparedTargetActivity = null;
                    }
					playbackTarget = ownedPlaybackTarget with
					{
						RequirePcmStopped = false,
						RequirePreparedSelection = false,
						PreparationSelectedSourceUri = null,
                        RequireSeekParkEvidence = false, SeekParkReceipt = null
					};
					preparedSelectionTarget = null;
					preparedSelectionCompleted = true;
					lastContact = monotonic();
					return Reply(obj, ok: true, "heldPaused", "PREPARED_SELECTION_COMPLETED")with
					{
						PreparedSelectionCompleted = true
					};
				}
				case "seekPark":
                case "holdExternalSelection":
                case "suspendPaused":
                {
                    var boundedSeek = text2 == "seekPark";
                    var externalSelection = text2 == "holdExternalSelection";
                    if (boundedSeek && !backend.Capabilities.BoundedSeekPark) throw new RouteBlockedException("SEEK_PARK_UNSUPPORTED");
                    var suspendStarted = monotonic();
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.IndefiniteHeldPause) throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
                    // An interrupted selection can be parked on the same journal.
                    // It grants no target-activity witness; the next selection must prove activity again.
                    var interruptedPreparation = text2 == "suspendPaused" && preparedSelectionTarget is not null
                        && !preparedSelectionCompleted && !resumeAuthorized && !pausedHeld
                        && lifetime.IntervalId is null && lifetime.IntervalGeneration == 0;
                    if ((!externalSelection && pausedHeld) || (!pausedHeld && !preparedSelectionCompleted && !interruptedPreparation)
                        || (preparedSelectionTarget is not null && !interruptedPreparation)
                        || PositiveInteger(jsonElement, "intervalEpoch") != intervalEpoch)
                        throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    // Cleanup must remain possible after the capture child has exited.
                    // Keep parent/journal authority and require fresh pause + PCM-stop proof;
                    // a seek park still requires its retained capture child to be live.
                    if (boundedSeek) lifetime.ValidateApplyAuthority(); else lifetime.ValidatePausedOwnerLiveness();
                    lifetime.ValidateOwnership(RequireRetention());
                    // Proof is freshly brokered and checked against native sessions;
                    // caller JSON cannot stand in for source pause or capture Stop ACK.
                    var paused = (interruptedPreparation ? preparedSelectionTarget! : playbackTarget).ForFreshRecovery()
                        with { AllowPreviousPaused = false, PausedPreviousTrackUri = null };
                    if (externalSelection)
                    {
                        if (!backend.Capabilities.ProviderRouteLifetime || seekParked
                            || Text(jsonElement, "pausedSourceUri") != playbackTarget.TrackUri
                            || playbackTarget.SourceEpoch == int.MaxValue
                            || PositiveInteger(jsonElement, "sourceEpoch") != playbackTarget.SourceEpoch + 1)
                            throw new RouteBlockedException("SOURCE_EPOCH_MISMATCH");
                        var selected = Text(jsonElement, "selectedSourceUri");
                        if (!OwnedPlaybackTarget.IsSelectedSourceUri(selected) || selected == playbackTarget.TrackUri)
                            throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
                        // Adopt only a freshly verified paused external selection, with PCM stopped.
                        // The original role journal and policy lease are never replaced.
                        paused = paused with { TrackUri = selected, SourceEpoch = playbackTarget.SourceEpoch + 1 };
                    }
                    OwnedSeekParkReceipt? parkReceipt = null;
                    if (boundedSeek)
                    {
                        if (lifetime.IntervalId is null || !resumeAuthorized) throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
                        parkReceipt = OwnedSeekParkReceipt.Read(jsonElement.GetProperty("captureParkReceipt"));
                        parkReceipt.Validate(session!, lastCaptureGeneration, Text(jsonElement, "seekTransaction"), now());
                        paused = paused with { RequirePcmStopped = false, RequireSeekParkEvidence = true, SeekParkReceipt = parkReceipt };
                    }
                    var reusePause = jsonElement.TryGetProperty("reusePauseObservation", out var requestedPauseReuse)
                        && requestedPauseReuse.ValueKind == JsonValueKind.True;
                    if (externalSelection && reusePause) throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    if (jsonElement.TryGetProperty("reusePauseObservation", out requestedPauseReuse)
                        && requestedPauseReuse.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    if (reusePause && !backend.Capabilities.BoundedPausedHoldObservation)
                        throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
                    // Reuse only the main process's one-use, current Pause GET.
                    // Native identity, full inactive-session scan and PCM-stop
                    // verification still surround two reads of that same receipt.
                    var pauseProof = reusePause ? paused with { RequirePreparationObservation = true,
                        PreparationPhase = "selected", RequirePausedHoldObservation = true } : paused;
                    try { lifetime.VerifyPausedSource(pauseProof); }
                    catch (RouteBlockedException error) when (reusePause && error.Message == "PAUSED_HOLD_OBSERVATION_EXPIRED")
                    {
                        // Abandon the complete old proof, not just its second read.
                        // Preserve the original 22-second host deadline and reserve
                        // the full two 6-second reads plus 2-second native scan.
                        if (monotonic() - suspendStarted > TimeSpan.FromSeconds(6)) throw;
                        if (boundedSeek) lifetime.ValidateApplyAuthority(); else lifetime.ValidatePausedOwnerLiveness();
                        lifetime.ValidateOwnership(RequireRetention());
                        lifetime.VerifyPausedSource(paused);
                    }
                    pausedProofTransferId = null;
                    if (reusePause && backend.Capabilities.BoundedPausedProofTransfer)
                    {
                        var offer = Guid.NewGuid().ToString("D");
                        if (lifetime.IssuePausedProofTransfer(offer, pauseProof, now()))
                        { pausedProofTransferId = offer; pausedProofTransferEpoch = intervalEpoch + 1; }
                    }
                    resumeAuthorized = false;
                    var heldAgain = pausedHeld ? ValidateOwnershipAndPolicy() : transaction.HoldPaused();
                    if (heldAgain.Stage != RouteStage.HeldPaused) return StageReply(obj, heldAgain);
                    if (boundedSeek) lifetime.ParkSeekCaptureInterval(parkReceipt!); else lifetime.SuspendCaptureInterval();
                    if (lifetime.IntervalId is not null || lifetime.IntervalGeneration != 0 || lifetime.IntervalIsolated)
                        throw new RouteBlockedException("CAPTURE_INTERVAL_NOT_STOPPED");
                    playbackTarget = paused; pausedHeld = true; preparedSelectionCompleted = false; lastContact = monotonic();
                    if (interruptedPreparation) { preparedSelectionTarget = null; preparedTargetActivity = completedTargetActivity = null; }
                    if (externalSelection) { InvalidatePausedProofTransfer(); preparedTargetActivity = completedTargetActivity = null; }
                    if (boundedSeek)
                    {
                        seekParkReceipt = parkReceipt; seekRouteToken = Guid.NewGuid().ToString("D"); seekParked = true;
                        var remaining = 5000 - (now().ToUnixTimeMilliseconds() - parkReceipt!.ResetBoundary.StoppedAndResetAtUnixMs);
                        if (remaining <= 0) throw new RouteBlockedException("SEEK_PARK_EXPIRED");
                        seekParkDeadline = monotonic() + TimeSpan.FromMilliseconds(remaining);
                        return Reply(obj, true, "seekParked", "SEEK_ROUTE_PARKED") with { PausedProofTransferId = pausedProofTransferId,
                            SeekParked = true, SeekRouteToken = seekRouteToken, ExpiresInMs = (int)remaining };
                    }
                    return Reply(obj, true, "pausedHeld", "PAUSED_ROUTE_HELD") with { PausedProofTransferId = pausedProofTransferId };
                }
                case "seekCancelToPaused":
                {
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.BoundedSeekPark || seekParkReceipt is null
                        || Text(jsonElement, "seekTransaction") != seekParkReceipt.SeekTransaction
                        || PositiveInteger(jsonElement, "intervalEpoch") != intervalEpoch)
                        throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
                    var paused = (preparedSelectionTarget ?? playbackTarget).ForFreshRecovery();
                    lifetime.VerifyPausedSource(paused);
                    lifetime.ValidateOwnership(RequireRetention());
                    var retained = transaction.HoldPaused();
                    if (retained.Stage != RouteStage.HeldPaused) return StageReply(obj, retained);
                    lifetime.CancelSeekCaptureInterval();
                    completedTargetActivity = preparedTargetActivity ?? completedTargetActivity; preparedTargetActivity = null;
                    preparedSelectionTarget = null; preparedSelectionCompleted = false; playbackTarget = paused;
                    seekParked = false; seekParkReceipt = null; seekRouteToken = null;
                    InvalidatePausedProofTransfer(); pausedHeld = true; resumeAuthorized = false; lastContact = monotonic();
                    return Reply(obj, true, "pausedHeld", "PAUSED_ROUTE_HELD");
                }
                case "seekResumePreparation":
                case "resumePreparation":
                {
                    var boundedSeek = text2 == "seekResumePreparation";
                    if (boundedSeek != seekParked) throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
                    if (boundedSeek && (!backend.Capabilities.BoundedSeekPark || seekParkReceipt is null
                        || OptionalText(jsonElement, "seekRouteToken") != seekRouteToken
                        || OptionalText(jsonElement, "seekTransaction") != seekParkReceipt.SeekTransaction))
                        throw new RouteBlockedException("SEEK_PARK_TOKEN_INVALID");
                    if (boundedSeek && monotonic() >= seekParkDeadline) throw new RouteBlockedException("SEEK_PARK_EXPIRED");
                    RequireLease(jsonElement); RequireHealthyJournal();
                    if (!backend.Capabilities.IndefiniteHeldPause || !backend.Capabilities.FreshResumeInterval)
                        throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
                    if (!pausedHeld || resumeAuthorized || preparedSelectionTarget is not null || lifetime.IntervalId is not null)
                        throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
                    int nextEpoch = PositiveInteger(jsonElement, "intervalEpoch");
                    if (intervalEpoch == int.MaxValue || nextEpoch != intervalEpoch + 1)
                        throw new RouteBlockedException("CAPTURE_INTERVAL_EPOCH_MISMATCH");
                    var sameTrack = Text(jsonElement, "selectedSourceUri");
                    if (!OwnedPlaybackTarget.IsSelectedSourceUri(sameTrack) || sameTrack != playbackTarget.TrackUri)
                        throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
                    var retained = ValidateOwnershipAndPolicy();
                    if (retained.Stage != RouteStage.HeldPaused) return StageReply(obj, retained);
                    var transferId = OptionalText(jsonElement, "pausedProofTransferId");
                    var intentId = OptionalText(jsonElement, "resumeIntentId");
                    var offeredId = pausedProofTransferId; pausedProofTransferId = null;
                    if (transferId is not null && (!backend.Capabilities.BoundedPausedProofTransfer
                        || transferId != offeredId || pausedProofTransferEpoch != nextEpoch
                        || !Guid.TryParseExact(intentId, "D", out _)))
                        throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_INVALID");
                    if (transferId is null && intentId is not null) throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_INVALID");
                    if (boundedSeek) { seekRouteToken = null; lifetime.BeginSeekResumePreparation(seekParkReceipt!, transferId, intentId); }
                    else if (transferId is null) lifetime.BeginResumePreparation();
                    else lifetime.BeginResumePreparation(transferId, intentId!);
                    var fresh = playbackTarget.ForFreshRecovery() with { RequirePcmStopped = !boundedSeek,
                        RequireSeekParkEvidence = boundedSeek, SeekParkReceipt = boundedSeek ? seekParkReceipt : null,
                        RequirePreparedSelection = true, PreparationSelectedSourceUri = sameTrack,
                        RequirePreparationObservation = backend.Capabilities.BoundedPreparationObservation,
                        PreparationPhase = transferId is not null ? "selected" : backend.Capabilities.BoundedPreparationObservation ? "baseline" : null,
                        PausedProofTransferId = transferId, ResumeIntentId = intentId };
                    try { lifetime.VerifyPausedSource(fresh); }
                    catch (RouteBlockedException error) when (transferId is not null && (error.Message == "PAUSED_PROOF_TRANSFER_EXPIRED" || error.Message == "PAUSED_PROOF_TRANSFER_SUPERSEDED"))
                    {
                        lifetime.FinishPausedProofTransfer();
                        if (boundedSeek) lifetime.RestartSeekSourcePreparation(); else lifetime.BeginResumePreparation();
                        fresh = fresh with { PreparationPhase = "baseline", PausedProofTransferId = null,
                            ResumeIntentId = null, PausedProofTransferFallback = true };
                        lifetime.VerifyPausedSource(fresh);
                    }
                    finally { lifetime.FinishPausedProofTransfer(); }
                    fresh = fresh with { PausedProofTransferId = null, ResumeIntentId = null, PausedProofTransferFallback = false };
                    lifetime.ValidateApplyAuthority(); lifetime.ValidateOwnership(RequireRetention());
                    if (backend.Capabilities.PreparedTargetActivity)
                    {
                        // Same-owner resume may reuse history after fresh pause/policy
                        // proof, without inventing stream continuity or replaying select.
                        var afterPause = ValidateOwnershipAndPolicy();
                        if (afterPause.Stage != RouteStage.HeldPaused) return StageReply(obj, afterPause);
                        if (completedTargetActivity?.Matches(afterPause, leaseId!, generation, sameTrack, intervalEpoch) != true)
                            throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_REQUIRED");
                        preparedTargetActivity = completedTargetActivity with { PreparationEpoch = nextEpoch };
                        completedTargetActivity = null;
                    }
                    playbackTarget = fresh; preparedSelectionTarget = fresh;
                    intervalEpoch = nextEpoch; pausedHeld = false; seekParked = false; lastContact = monotonic();
                    return Reply(obj, true, "preparedSelection", "RESUME_PREPARATION_AUTHORIZED") with
                    { PreparedSelectionAuthorized = true, PreparedTargetActive = preparedTargetActivity is not null };
                }
                case "armCaptureInterval":
				{
					RequireLease(jsonElement);
					if ((object)preparedSelectionTarget != null)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_IN_PROGRESS");
					}
					if (backend.Capabilities.PreparedSelection && !preparedSelectionCompleted)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_INVALID_STATE");
					}
					if (resumeAuthorized || lifetime.IntervalGeneration != 0 || lifetime.IntervalId != null)
					{
						throw new RouteBlockedException("CAPTURE_INTERVAL_ALREADY_ARMED");
					}
					RouteRecord routeRecord2 = ValidateOwnershipAndPolicy();
					if (routeRecord2.Stage != RouteStage.HeldPaused)
					{
						return StageReply(obj, routeRecord2);
					}
					OwnedSilentRenderLeaseProof ownedSilentRenderLeaseProof = OwnedSilentRenderLeaseProof.Read(jsonElement, session, discovery.Selection.RenderDeviceId);
					if (backend.Capabilities.OwnedSilentRenderLease && ownedSilentRenderLeaseProof is null)
                        throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_INVALID");
                    if ((object)ownedSilentRenderLeaseProof != null)
                    {
                        if (ownedSilentRenderLeaseProof.CaptureGeneration <= lastCaptureGeneration)
                            throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_INVALID");
                        lastCaptureGeneration = ownedSilentRenderLeaseProof.CaptureGeneration;
                        lifetime.BindOwnedSilentRenderLease(ownedSilentRenderLeaseProof);
					}
					lifetime.VerifyPausedSource(playbackTarget);
					lifetime.ArmCaptureInterval(session, generation);
					lastContact = monotonic();
					if (!lifetime.IntervalIsolated || lifetime.IntervalGeneration != generation || string.IsNullOrWhiteSpace(lifetime.IntervalId))
					{
						throw new RouteBlockedException("CAPTURE_INTERVAL_ISOLATION_LOST");
					}
					return Reply(obj, ok: true, "heldPaused", "CAPTURE_INTERVAL_ARMED");
				}
				case "authorizeResume":
				{
					RequireLease(jsonElement);
					if ((object)preparedSelectionTarget != null)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_IN_PROGRESS");
					}
					if (backend.Capabilities.PreparedSelection && !preparedSelectionCompleted)
					{
						throw new RouteBlockedException("PREPARED_SELECTION_INVALID_STATE");
					}
					if (resumeAuthorized)
					{
						throw new RouteBlockedException("RESUME_ALREADY_AUTHORIZED");
					}
					if (!Flag(jsonElement, "captureStarted") || !Flag(jsonElement, "monitorGainZero"))
					{
						throw new RouteBlockedException("PRIVATE_CAPTURE_AND_ZERO_PCM_GATE_REQUIRED");
					}
					if (!lifetime.IntervalIsolated || lifetime.IntervalGeneration != generation)
					{
						throw new RouteBlockedException("CAPTURE_INTERVAL_ISOLATION_LOST");
					}
					RouteRecord routeRecord3 = ValidateOwnershipAndPolicy();
					if (routeRecord3.Stage != RouteStage.HeldPaused)
					{
						return StageReply(obj, routeRecord3);
					}
					string text3 = Text(jsonElement, "selectedSourceUri");
					if (text3.Length > 2048)
					{
						throw new RouteBlockedException("SOURCE_URI_LIMIT");
					}
					if (preparedSelectionCompleted && text3 != playbackTarget.TrackUri)
					{
						throw new RouteBlockedException("SOURCE_TRACK_CHANGED");
					}
					lifetime.VerifyPausedSource(playbackTarget);
					lifetime.ValidateApplyAuthority();
					if (!lifetime.IntervalIsolated || lifetime.IntervalGeneration != generation || string.IsNullOrWhiteSpace(lifetime.IntervalId))
					{
						throw new RouteBlockedException("CAPTURE_INTERVAL_ISOLATION_LOST");
					}
					playbackTarget = ((playbackTarget.TrackUri == text3) ? playbackTarget with
					{
						PausedPreviousTrackUri = null,
						AllowPreviousPaused = false
					} : playbackTarget with
					{
						TrackUri = text3,
						PausedPreviousTrackUri = playbackTarget.TrackUri,
						AllowPreviousPaused = true
					});
					resumeAuthorized = true;
					lastContact = monotonic();
					return Reply(obj, ok: true, "resumeAuthorized", "RESUME_AUTHORIZED", ready: false, caps: false, null, resume: true);
				}
				case "validate":
				case "status":
				{
					RequireLease(jsonElement);
					RequireHealthyJournal();
					lifetime.ValidateApplyAuthority();
					lifetime.ValidateOwnership(RequireRetention());
					RouteRecord record = ((!resumeAuthorized) ? transaction.ValidateHeldPaused() : ((transaction.Inspect().Stage != RouteStage.HeldPaused) ? transaction.ValidateActive() : transaction.ActivateHeld()));
					lastContact = monotonic();
					return StageReply(obj, record);
				}
				case "heartbeat":
					RequireLease(jsonElement);
                    if (seekParked && monotonic() >= seekParkDeadline) throw new RouteBlockedException("SEEK_PARK_EXPIRED");
					RequireHealthyJournal();
                    if (pausedHeld) lifetime.ValidatePausedOwnerLiveness(); else lifetime.ValidateApplyAuthority();
					lifetime.ValidateOwnership(RequireRetention());
					lastContact = monotonic();
					return Reply(obj, ok: true, seekParked ? "seekParked" : pausedHeld ? "pausedHeld" : ((object)preparedSelectionTarget == null) ? WireState(transaction.Inspect().Stage) : "preparedSelection", "HEARTBEAT");
				case "release":
					if (lifetime == null && (object)lastRelease != null)
					{
						RequireLeaseKey(jsonElement);
						return lastRelease with
						{
							Id = obj
						};
					}
					RequireLease(jsonElement);
					return ReleaseLocked(obj, "RELEASED");
				case "close":
				case "shutdown":
					return ShutdownLocked(obj, "SHUTDOWN");
				default:
					throw new RouteBlockedException("UNKNOWN_COMMAND");
				}
			}
			catch (Exception ex) when (((ex is JsonException || ex is InvalidDataException) ? 1 : 0) != 0)
			{
				return ShutdownLocked(obj, "CONTROL_PROTOCOL_INVALID:" + ex.Message);
			}
			catch (JournalUnavailableException ex2)
			{
                InvalidatePausedProofTransfer();
				journalFailed = true;
				resumeAuthorized = false;
				return Reply(obj, ok: false, "recoveryRequired", ex2.Message);
			}
			catch (Exception ex3) when (((ex3 is RouteBlockedException || ex3 is JsonException || ex3 is InvalidOperationException || ex3 is FormatException || ex3 is OverflowException || ex3 is ArgumentException) ? 1 : 0) != 0)
			{
                InvalidatePausedProofTransfer();
                if (ex3.Message.Split(':', 2)[0] is "SOURCE_TRACK_CHANGED" or "SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH"
                    or "PREPARATION_OBSERVATION_INVALID" or "PREPARATION_OBSERVATION_CHANGED_DURING_SCAN"
                    or "SPOTIFY_INSTANCE_CHANGED" or "SPOTIFY_CANDIDATE_SET_CHANGED"
                    or "EXTERNAL_POLICY_CONFLICT" or "COMMUNICATIONS_POLICY_CHANGED")
                    preparedTargetActivity = completedTargetActivity = null;
				object id = obj;
				string state = ((!backend.Capabilities.Supported) ? "unsupported" : ((lifetime == null) ? "blocked" : "held"));
				return Reply(id, ok: false, state, ex3.Message, ready: false, !backend.Capabilities.Supported)with
				{
					PhysicalOwnerDiagnostic = PhysicalOwnerDiagnosticProjection.FromFailure(ex3.Message, (ex3 as RouteBlockedException)?.Diagnostic)
				};
			}
			catch (Exception ex4)
			{
                InvalidatePausedProofTransfer();
				resumeAuthorized = false;
				return Reply(obj, ok: false, (lifetime == null) ? "blocked" : "recoveryRequired", ex4.GetType().Name + ":" + ex4.Message);
			}
		}
	}

	private ServiceReply Acquire(object id, JsonElement payload)
	{
		RequireCapability();
		if (lifetime != null)
		{
			throw new RouteBlockedException("LEASE_ALREADY_OWNED");
		}
		string text = Text(payload, "session");
		if (text.Length > 128)
		{
			throw new RouteBlockedException("SESSION_ID_LIMIT");
		}
		int num = PositiveInteger(payload, "generation");
		if (!Flag(payload, "sourcePaused"))
		{
			throw new RouteBlockedException("SOURCE_PAUSE_CONFIRMATION_REQUIRED");
		}
		RouteSelection routeSelection = Selection(payload);
		ProductDiscovery found = backend.InspectForAcquire(routeSelection);
		RequireDiscovery(found, routeSelection);
		if (!found.SourcePaused)
		{
			throw new RouteBlockedException("SOURCE_NOT_PAUSED");
		}
		int num2 = PositiveInteger(payload, "expectedSpotifyProcessId");
		string text2 = Text(payload, "expectedSpotifyStartTimeUtcTicks");
		if (num2 != found.Identity.Pid || text2 != ProcessWire.From(found.Identity).StartTimeUtcTicks)
		{
			throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
		}
		string text3 = Text(payload, "sourceDeviceId");
		if (text3.Length > 256)
		{
			throw new RouteBlockedException("SOURCE_DEVICE_LIMIT");
		}
		JsonElement value;
		bool flag = !payload.TryGetProperty("expectedSourceUri", out value);
		if (!flag)
		{
			JsonValueKind valueKind = value.ValueKind;
			bool flag2 = ((valueKind == JsonValueKind.String || valueKind == JsonValueKind.Null) ? true : false);
			flag = !flag2;
		}
		if (flag)
		{
			throw new RouteBlockedException("SOURCE_URI_BINDING_REQUIRED");
		}
		string text4 = value.GetString();
		if ((text4 != null && text4.Length > 2048) || (text4 != null && string.IsNullOrWhiteSpace(text4)))
		{
			throw new RouteBlockedException("SOURCE_URI_INVALID");
		}
		IProductRouteLifetime owned = backend.Open(found);
		lifetime = owned;
		discovery = found;
		playbackTarget = new OwnedPlaybackTarget(text3, text4, found.Identity, null, AllowPreviousPaused: false, backend.Capabilities.BoundedPreparationObservation, RequirePreparedSelection: false, null, backend.Capabilities.BoundedPreparationObservation, backend.Capabilities.BoundedPreparationObservation ? "baseline" : null);
		session = text;
		generation = num;
        intervalEpoch = 1; lastCaptureGeneration = 0; pausedHeld = false; restoreAttempted = false;
		leaseId = Guid.NewGuid().ToString("D");
		owned.BindLease(session, generation, leaseId);
		retention = null;
		resumeAuthorized = false;
		preparedSelectionTarget = null;
		preparedSelectionCompleted = false;
        preparedTargetActivity = completedTargetActivity = null;
		journalFailed = false;
		lastRelease = null;
		lastContact = monotonic();
		transaction = new OwnedRouteTransaction(new OwnedResolver(owned.Resolver, delegate
		{
			RequireHealthyJournal();
			owned.ValidateOwnership(RequireRetention());
			RouteRecord? routeRecord = owned.Journal.ReadLatest();
			if ((object)routeRecord != null && routeRecord.Stage == RouteStage.Applying)
			{
				owned.ValidateApplyAuthority();
			}
		}), owned.EndpointVerifier, owned.Observer, new AckJournal(owned.Journal, delegate(RouteRecord routeRecord)
		{
			if (routeRecord.Stage == RouteStage.Prepared)
			{
				if ((object)retention != null)
				{
					throw new JournalUnavailableException("PREPARED_ACK_REPLAY");
				}
				if (!routeRecord.Roles.Select((RouteRole x) => x.Original).SequenceEqual<string>(found.OriginalValues))
				{
					throw new JournalUnavailableException("INSPECTED_ORIGINALS_CHANGED");
				}
				PreparedRetention preparedRetention = owned.RetainAndAcknowledgePrepared(routeRecord);
				if (preparedRetention.TransactionId != routeRecord.TransactionId || preparedRetention.Process != routeRecord.CurrentProcess || preparedRetention.CommittedLength <= 0 || preparedRetention.FrameHash.Length != 64 || !preparedRetention.FrameHash.All(Uri.IsHexDigit) || string.IsNullOrWhiteSpace(preparedRetention.FileIdentity) || !preparedRetention.RootPinned || !preparedRetention.RetainedDuplicate || !preparedRetention.PreparedAck)
				{
					throw new JournalUnavailableException("PREPARED_RETAIN_ACK_INVALID");
				}
				owned.ValidateOwnership(preparedRetention);
				retention = preparedRetention;
			}
		}), now);
		owned.ValidateApplyAuthority();
		owned.VerifyPausedSource(playbackTarget);
		RouteRecord record = transaction.AcquirePaused(found.Identity, found.Target);
		lastContact = monotonic();
		return StageReply(id, record);
	}

	private RouteRecord ValidateOwnershipAndPolicy()
	{
		RequireHealthyJournal();
		lifetime.ValidateApplyAuthority();
		lifetime.ValidateOwnership(RequireRetention());
		return transaction.ValidateHeldPaused();
	}

    private void InvalidatePausedProofTransfer()
    {
        pausedProofTransferId = null; pausedProofTransferEpoch = 0;
        if (seekParked) seekRouteToken = null;
        lifetime?.FinishPausedProofTransfer();
    }

	private ServiceReply ReleaseLocked(object? id, string reason)
	{
        seekRouteToken = null; seekParked = false; seekParkReceipt = null;
        InvalidatePausedProofTransfer();
		resumeAuthorized = false;
        preparedTargetActivity = completedTargetActivity = null;
		if (lifetime == null)
		{
			return Reply(id, ok: true, "idle", reason);
		}
		if (journalFailed)
		{
			return Reply(id, ok: false, "recoveryRequired", "JOURNAL_FAILURE_REQUIRES_SUPERVISOR_RECOVERY");
		}
		try
		{
			RouteRecord routeRecord = transaction.Inspect();
			if ((object)routeRecord == null)
			{
				lifetime.Dispose();
				lifetime = null;
				transaction = null;
				return Reply(id, ok: true, "idle", "NO_POLICY_WRITES");
			}
			lifetime.ValidateOwnership(RequireRetention());
			playbackTarget = (preparedSelectionTarget ?? playbackTarget).ForFreshRecovery();
			bool flag = reason == "RELEASED" && !restoreAttempted && backend.Capabilities.BoundedRestoreObservation;
			RouteStage stage = default(RouteStage);
			if (flag)
			{
				stage = routeRecord.Stage;
				bool flag2 = ((stage == RouteStage.Active || stage == RouteStage.HeldPaused) ? true : false);
				flag = flag2;
			}
			if (flag)
			{
				playbackTarget = playbackTarget with
				{
					RestoreOperationId = Guid.NewGuid().ToString("D"),
					RestoreStartedAtUtc = now(),
                    AllowChangedTrackPausedForRestore = true,
                    AllowEmptyPlayerForRestore = true
				};
			}
			try
			{
				lifetime.VerifyPausedSource(playbackTarget);
			}
			catch (RouteBlockedException ex) when (((Func<bool>)delegate
			{
				// Could not convert BlockContainer to single expression
				flag = reason == "RELEASED" && !restoreAttempted;
				if (flag)
				{
					stage = routeRecord.Stage;
					flag = ((stage == RouteStage.Active || stage == RouteStage.HeldPaused) ? true : false);
				}
				return flag && RetryableSourceProof(ex.Message);
			}).Invoke())
			{
				lastContact = monotonic();
				return Reply(id, ok: false, WireState(routeRecord.Stage), ex.Message.Split(':', 2)[0])with
				{
					State = "recoveryRequired",
					CleanupRetryable = true,
					RestoreWritesStarted = false
				};
			}
			restoreAttempted = true;
			RouteRecord routeRecord2 = transaction.Restore();
			stage = routeRecord2.Stage;
			if ((uint)(stage - 4) > 1u)
			{
				return StageReply(id, routeRecord2);
			}
			lifetime.VerifyRestoredTerminal(routeRecord2, RequireRetention());
			ProductDefaultStatus productDefaultStatus = lifetime.ReadDefaultStatus();
            pausedHeld = false;
			ServiceReply result = Reply(id, ok: true, "restored", reason, ready: false, caps: false, null, resume: false, restored: true, productDefaultStatus.Unchanged)with
			{
				Defaults = productDefaultStatus,
				ObservedDefaultsChanged = !productDefaultStatus.Unchanged
			};
			lifetime.Dispose();
			lifetime = null;
			transaction = null;
			retention = null;
			preparedSelectionTarget = null;
			lastRelease = result;
			return result;
		}
		catch (JournalUnavailableException ex2)
		{
			journalFailed = true;
			return Reply(id, ok: false, "recoveryRequired", ex2.Message);
		}
		catch (Exception ex3)
		{
			return Reply(id, ok: false, "recoveryRequired", ex3.Message);
		}
	}

	private static bool RetryableSourceProof(string code)
	{
		switch (code.Split(':', 2)[0])
		{
		case "PCM_STOP_NOT_CONFIRMED":
		case "SOURCE_NOT_PAUSED":
		case "SOURCE_BROKER_UNAVAILABLE":
		case "SOURCE_BROKER_FAILED":
		case "EMPTY_PLAYER_NATIVE_QUIESCENCE_UNCONFIRMED":
		case "EMPTY_PLAYER_NATIVE_QUIESCENCE_EXPIRED":
			return true;
		default:
			return false;
		}
	}

	private ServiceReply ShutdownLocked(object? id, string reason)
	{
		ServiceReply serviceReply = ((lifetime == null && (object)lastRelease != null) ? lastRelease with
		{
			Id = id,
			Code = reason
		} : ReleaseLocked(id, reason));
		closed = true;
		if (!serviceReply.Ok)
		{
			return serviceReply;
		}
		return serviceReply with
		{
			State = "closed",
			Code = ((serviceReply.State == "idle" && reason == "SHUTDOWN") ? "NO_POLICY_WRITES" : serviceReply.Code)
		};
	}

	public ServiceReply Disconnect(string reason)
	{
		lock (gate)
		{
			return ShutdownLocked(null, reason);
		}
	}

	public ServiceReply? CheckDeadline()
	{
		lock (gate)
		{
			return (!closed && lifetime != null && monotonic() - lastContact >= IdleLimit) ? ShutdownLocked(null, "OWNER_HEARTBEAT_EXPIRED") : null;
		}
	}

	public void Dispose()
	{
		lock (gate)
		{
			if (!closed)
			{
				ShutdownLocked(null, "DISPOSED");
			}
			lifetime?.Dispose();
			lifetime = null;
		}
	}

	private void RequireCapability()
	{
		if (!backend.Capabilities.CanOperate)
		{
			throw new RouteBlockedException("NATIVE_PRODUCT_ADAPTER_UNQUALIFIED");
		}
	}

	private static void RequireDiscovery(ProductDiscovery found, RouteSelection requested)
	{
		if (found.Selection != requested || found.Target.Id != requested.RenderDeviceId || !found.Identity.WellFormed || !found.Target.Eligible || found.OriginalValues.Length != 3 || !found.BaseCableVerified || !found.NoOtherWriters || !found.OriginalPolicySafe || found.SourceOutputDefault != found.OriginalValues.Take(2).All((string value) => value == null))
		{
			throw new RouteBlockedException("PRODUCT_DISCOVERY_UNQUALIFIED");
		}
	}

	private PreparedRetention RequireRetention()
	{
		return retention ?? throw new JournalUnavailableException("PREPARED_RETAIN_ACK_REQUIRED");
	}

	private void RequireHealthyJournal()
	{
		if (journalFailed)
		{
			throw new JournalUnavailableException("JOURNAL_FAILURE_REQUIRES_SUPERVISOR_RECOVERY");
		}
	}

	private void RequireLease(JsonElement payload)
	{
		if (lifetime == null)
		{
			throw new RouteBlockedException("NO_OWNED_LEASE");
		}
		RequireLeaseKey(payload);
	}

	private void RequireLeaseKey(JsonElement payload)
	{
		if (Text(payload, "session") != session || PositiveInteger(payload, "generation") != generation || Text(payload, "leaseId") != leaseId)
		{
			throw new RouteBlockedException("LEASE_IDENTITY_MISMATCH");
		}
	}

	private ServiceReply StageReply(object? id, RouteRecord record)
	{
        if (record.Stage == RouteStage.Active) { seekParkReceipt = null; seekRouteToken = null; }
        if (seekParked && record.Stage == RouteStage.HeldPaused) return Reply(id, true, "seekParked", "SEEK_ROUTE_PARKED");
        if (pausedHeld && record.Stage == RouteStage.HeldPaused) return Reply(id, true, "pausedHeld", "PAUSED_ROUTE_HELD");
		if ((object)preparedSelectionTarget != null && record.Stage == RouteStage.HeldPaused)
		{
			return Reply(id, ok: true, "preparedSelection", "PREPARED_SELECTION_IN_PROGRESS");
		}
		RouteStage stage = record.Stage;
		bool flag = ((stage == RouteStage.Active || stage == RouteStage.HeldPaused) ? true : false);
		bool flag2 = flag;
		if (record.Stage == RouteStage.Active || (record.Stage == RouteStage.HeldPaused && lifetime?.IntervalId != null))
		{
			IProductRouteLifetime? productRouteLifetime = lifetime;
			if (productRouteLifetime == null || !productRouteLifetime.IntervalIsolated || lifetime.IntervalGeneration != generation || string.IsNullOrWhiteSpace(lifetime.IntervalId))
			{
				return Reply(id, ok: false, "recoveryRequired", "CAPTURE_INTERVAL_ISOLATION_LOST");
			}
		}
		return Reply(id, flag2, WireState(record.Stage), record.Issue ?? (flag2 ? ("ROUTE_" + record.Stage.ToString().ToUpperInvariant()) : "ROUTE_NOT_READY"), record.Stage == RouteStage.Active && resumeAuthorized);
	}

	private ServiceReply Reply(object? id, bool ok, string state, string code, bool ready = false, bool caps = false, object? inspection = null, bool resume = false, bool restored = false, bool defaults = false)
	{
		ProductCapabilities capabilities = (caps ? backend.Capabilities : null);
		var lease = (((object)discovery == null) ? null : new
		{
			leaseId = leaseId,
			session = session,
			generation = generation,
			state = state,
			ready = ready,
			process = ProcessWire.From(discovery.Identity),
			originalRoles = discovery.OriginalValues.Take(2).Select((string v, int i) => new OriginalRole(i, v)).ToArray(),
			captureDeviceId = discovery.Selection.CaptureDeviceId,
			renderDeviceId = discovery.Selection.RenderDeviceId,
			sourceDeviceId = playbackTarget?.DeviceId,
            sourceEpoch = playbackTarget?.SourceEpoch,
			expectedSourceUri = playbackTarget?.TrackUri,
			intervalIsolated = (lifetime?.IntervalIsolated ?? false)
		});
		IProductRouteLifetime? productRouteLifetime = lifetime;
		bool intervalIsolated = productRouteLifetime != null && productRouteLifetime.IntervalIsolated && lifetime.IntervalGeneration == generation;
		int? intervalGeneration = lifetime?.IntervalGeneration;
		bool intervalArmed = lifetime?.IntervalGeneration == generation && !string.IsNullOrWhiteSpace(lifetime?.IntervalId);
		string intervalId = lifetime?.IntervalId;
		return new ServiceReply(id, ok, state, code, ready, capabilities, inspection, lease, resume, restored, defaults, null, GlobalDefaultsWritten: false, null, intervalIsolated, intervalGeneration, intervalArmed, intervalId, PausedHeld: pausedHeld, IntervalEpoch: intervalEpoch);
	}

	private static string WireState(RouteStage stage)
	{
		switch (stage)
		{
		case RouteStage.HeldPaused:
			return "heldPaused";
		case RouteStage.Active:
			return "active";
		case RouteStage.Restored:
		case RouteStage.RolledBack:
			return "restored";
		default:
			return "recoveryRequired";
		}
	}

	private static void Unique(JsonElement value)
	{
		HashSet<string> hashSet = new HashSet<string>(StringComparer.Ordinal);
		foreach (JsonProperty item in value.EnumerateObject())
		{
			if (!hashSet.Add(item.Name))
			{
				throw new InvalidDataException("DUPLICATE_REQUEST_FIELD");
			}
		}
	}

	private static RouteSelection Selection(JsonElement p)
	{
		return new RouteSelection(Text(p, "captureDeviceId"), Text(p, "renderDeviceId"));
	}

	private static string Text(JsonElement p, string key)
	{
		return OptionalText(p, key) ?? throw new RouteBlockedException("MISSING_" + key);
	}

	private static string? OptionalText(JsonElement p, string key)
	{
		if (!p.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
		{
			return null;
		}
		return value.GetString();
	}

	private static int PositiveInteger(JsonElement p, string key)
	{
		if (!p.TryGetProperty(key, out var value) || !value.TryGetInt32(out var value2) || value2 <= 0)
		{
			throw new RouteBlockedException("POSITIVE_INTEGER_REQUIRED_" + key);
		}
		return value2;
	}

	private static bool Flag(JsonElement p, string key)
	{
		if (p.TryGetProperty(key, out var value))
		{
			return value.ValueKind == JsonValueKind.True;
		}
		return false;
	}
}
