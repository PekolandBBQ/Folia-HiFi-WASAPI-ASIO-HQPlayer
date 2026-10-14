// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using System;

namespace Folia.ProductRoute;

public sealed record PlaybackStatus(string DeviceId, string? TrackUri, bool? IsPlaying, DateTimeOffset ObservedAtUtc, bool PcmStopped = false, bool PreparationOwned = false, bool? PlaybackRequestPending = null, long? ObservationGeneration = null, long? MutationEpoch = null, string? PreparationPhase = null, long? PositionMs = null, string? RestoreOperationId = null, bool EmptyPlayer = false, bool PausedProofTransferSuperseded = false, OwnedSeekParkReceipt? CaptureParkReceipt = null);
