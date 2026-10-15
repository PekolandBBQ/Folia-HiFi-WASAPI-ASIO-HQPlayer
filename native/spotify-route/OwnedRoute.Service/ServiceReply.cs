// Source-equivalent reconstruction from verified dev11 managed assembly; original authored source was unavailable.
#nullable enable annotations
#nullable disable warnings
using Folia.RouteResearch;

namespace Folia.ProductRoute;

public sealed record ServiceReply(object? Id, bool Ok, string State, string Code, bool Ready = false, ProductCapabilities? Capabilities = null, object? Inspection = null, object? Lease = null, bool ResumeAuthorized = false, bool ExactOriginalRolesRestored = false, bool DefaultsUnchanged = false, ProductDefaultStatus? Defaults = null, bool GlobalDefaultsWritten = false, bool? ObservedDefaultsChanged = null, bool IntervalIsolated = false, int? IntervalGeneration = null, bool IntervalArmed = false, string? IntervalId = null, bool NoPolicyWrites = false, string? FailureCode = null, PhysicalOwnerDiagnostic? PhysicalOwnerDiagnostic = null, OperationFailureDiagnostic? OperationFailureDiagnostic = null, bool PreparedSelectionAuthorized = false, bool PreparedSelectionCompleted = false, bool CleanupRetryable = false, bool? RestoreWritesStarted = null, bool PausedHeld = false, int IntervalEpoch = 0, bool PreparedTargetActive = false, string? PausedProofTransferId = null, bool SeekParked = false, string? SeekRouteToken = null, int? ExpiresInMs = null, object? PreparationDiagnostic = null);
