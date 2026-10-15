using Folia.RouteResearch;
using System.Text.Json.Serialization;

namespace Folia.ProductRoute;

public sealed record ProductCapabilities(bool ProductionQualified, bool HeldPausedAcquire,
    bool CompleteSessionProof, bool NotificationCoherent, bool RetainedJournalRecovery, string[] Blockers, bool TrialAuthorized=false, string? ValidationProfile=null, bool IntervalIsolation=false, bool OwnedSilentRenderLease=false, bool PreparedSelection=false, bool BoundedPreparationObservation=false, bool BoundedRestoreObservation=false, bool IndefiniteHeldPause=false, bool FreshResumeInterval=false, bool BoundedPausedHoldObservation=false, bool PreparedTargetActivity=false, bool BoundedPausedProofTransfer=false, bool BoundedSeekPark=false, bool ProviderRouteLifetime=false, bool RuntimeCompatible=false, string? CompatibilityProfile=null, uint? WindowsBuild=null, string? RouteInterfaceId=null)
{
    public int ProtocolMajor => 1;
    public string ComponentVersion => "0.19.0-dev.30";
    public string Platform => "win32-x64";
    public string Contract => "folia-owned-route-v1";
    public bool ImplementationAvailable => IntervalIsolation && HeldPausedAcquire && CompleteSessionProof && NotificationCoherent && RetainedJournalRecovery && Blockers.Length == 0;
    public bool Supported => (ProductionQualified || RuntimeCompatible) && ImplementationAvailable;
    public bool CanOperate => ImplementationAvailable && (ProductionQualified || RuntimeCompatible || TrialAuthorized);
    public string[] Operations => ["hello", "inspect", "validateHeld", "acquire", "rebindPreparedSelection", "authorizePreparedSelection", "verifyPreparedTargetActive", "completePreparedSelection", "suspendPaused", "holdExternalSelection", "resumePreparation", "seekPark", "seekResumePreparation", "seekCancelToPaused", "armCaptureInterval", "authorizeResume", "status", "heartbeat", "release", "close"];
}
public sealed record RouteSelection(string CaptureDeviceId, string RenderDeviceId);
public sealed record OriginalRole(int Role, [property:JsonIgnore(Condition=JsonIgnoreCondition.Never)] string? Original);
public sealed record ProcessWire(int Pid, string StartTimeUtcTicks, long StartedAtUnixMs,
    string UserSid, string PolicyIdentity, string ImageIdentity, string Distribution)
{
    public static ProcessWire From(SpotifyProcess p) => new(p.Pid,
        p.StartTimeUtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture),
        new DateTimeOffset(p.StartTimeUtcTicks, TimeSpan.Zero).ToUnixTimeMilliseconds(),
        p.UserSid,p.PolicyIdentity,p.ImageIdentity,p.Distribution);
}
public sealed record ProductDiscovery(SpotifyProcess Identity, BaseRenderEndpoint Target,
    RouteSelection Selection, string?[] OriginalValues, bool SourcePaused, bool SourceOutputDefault,
    bool BaseCableVerified, bool DefaultsUnchanged, bool NoOtherWriters, bool OriginalPolicySafe=false)
{
    public object ToWire() => new { process=ProcessWire.From(Identity), sourcePaused=SourcePaused,
        sourceOutputDefault=SourceOutputDefault, baseCableVerified=BaseCableVerified,
        originalPolicySafe=OriginalPolicySafe,
        defaultsUnchanged=DefaultsUnchanged, noOtherWriters=NoOtherWriters,
        captureDeviceId=Selection.CaptureDeviceId,renderDeviceId=Selection.RenderDeviceId,
        originalRoles=OriginalValues.Take(2).Select((v,i)=>new OriginalRole(i,v)).ToArray() };
}

// A capability receipt is not a path or a client assertion. A production adapter
// must own the pinned root and retained duplicate throughout this object lifetime,
// validate the current child identity, and persist/verify full Prepared provenance.
public sealed record PreparedRetention(Guid TransactionId, SpotifyProcess Process,
    string FrameHash, long CommittedLength, string FileIdentity, bool RootPinned,
    bool RetainedDuplicate, bool PreparedAck);
public interface IProductRouteBackend
{
    ProductCapabilities Capabilities { get; }
    ProductDiscovery Inspect(RouteSelection selection);
    // Default keeps old adapters strict; Windows may reuse its exact fresh paused
    // inspection, revalidating original bindings again in Open before Prepared.
    ProductDiscovery InspectForAcquire(RouteSelection selection) => Inspect(selection);
    IProductRouteLifetime Open(ProductDiscovery discovery);
}
public sealed record ProductDefaultStatus(bool Unchanged,string?[] Frozen,string?[] Current,bool FeedbackRisk=false,string? FeedbackIssue=null);
public interface IProductRouteLifetime : IDisposable
{
    bool RequiresTargetEndpointActivity => true;
    void BindLease(string session,int generation,string leaseId) { }
    IVerifiedSpotifyResolver Resolver { get; }
    ISelectedEndpointVerifier EndpointVerifier { get; }
    ISessionObserver Observer { get; }
    IDurableRouteJournal Journal { get; }
    // Called after durable Prepared append. Returns only after supervisor ACK of
    // its independently verified retained duplicate; never reopens a path.
    PreparedRetention RetainAndAcknowledgePrepared(RouteRecord prepared);
    void ValidateOwnership(PreparedRetention retention);
    // Parent/control authority gates new apply and readiness, not compensation
    // through an already valid owned journal. Throw RouteBlockedException on loss.
    void ValidateApplyAuthority();
    // Fresh independent source pause and environment facts. No setter is allowed.
    void VerifyPausedSource(OwnedPlaybackTarget source);
    // Read every original role (including untouched communications), exact raw
    // value matching, default comparison, durable terminal + Prepared provenance.
    void VerifyRestoredTerminal(RouteRecord terminal, PreparedRetention retention);
    ProductDefaultStatus ReadDefaultStatus();
    bool IntervalIsolated { get; }
    int IntervalGeneration {get;}
    string? IntervalId {get;}
    void BindOwnedSilentRenderLease(OwnedSilentRenderLeaseProof proof) => throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_UNSUPPORTED");
    void ArmCaptureInterval(string session,int generation);
    void ValidatePausedOwnerLiveness() => throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
    void SuspendCaptureInterval() => throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
    void CancelSeekCaptureInterval() => throw new RouteBlockedException("SEEK_PARK_UNSUPPORTED");
    void RestartSeekSourcePreparation() => throw new RouteBlockedException("SEEK_PARK_UNSUPPORTED");
    void ParkSeekCaptureInterval(OwnedSeekParkReceipt receipt) => throw new RouteBlockedException("SEEK_PARK_UNSUPPORTED");
    void BeginSeekResumePreparation(OwnedSeekParkReceipt receipt, string? transferId, string? intentId) => throw new RouteBlockedException("SEEK_PARK_UNSUPPORTED");
    bool IssuePausedProofTransfer(string id, OwnedPlaybackTarget target, DateTimeOffset now) => false;
    void BeginResumePreparation(string id, string intent) => throw new RouteBlockedException("PAUSED_PROOF_TRANSFER_UNSUPPORTED");
    void FinishPausedProofTransfer() { }
    void BeginResumePreparation() => throw new RouteBlockedException("PAUSED_ROUTE_UNSUPPORTED");
}
public sealed class UnqualifiedProductBackend : IProductRouteBackend
{
    public ProductCapabilities Capabilities { get; } = new(false,false,false,false,false,
    ["COMPLETE_NOTIFICATION_COHERENT_SESSION_PROOF_MISSING", "PRODUCT_RETAINED_JOURNAL_SUPERVISOR_NOT_CONNECTED",
     "EXACT_WINDOWS_BUILD_ABI_NOT_QUALIFIED", "PAUSED_CAPTURE_BOOTSTRAP_NOT_HARDWARE_QUALIFIED",
     "HELD_ROUTE_LIFECYCLE_NOT_HARDWARE_QUALIFIED"]);
    public ProductDiscovery Inspect(RouteSelection selection) => throw new RouteBlockedException("NATIVE_PRODUCT_ADAPTER_UNQUALIFIED");
    public IProductRouteLifetime Open(ProductDiscovery discovery) => throw new RouteBlockedException("NATIVE_PRODUCT_ADAPTER_UNQUALIFIED");
}
