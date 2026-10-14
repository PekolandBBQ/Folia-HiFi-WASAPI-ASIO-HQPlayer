namespace Folia.RouteResearch;

// Device-free transaction contracts. Native COM is isolated in the separate route adapter and Windows host.
public enum RenderRole { Console, Multimedia, Communications }
public enum RouteStage { Prepared, Applying, Active, Restoring, Restored, RolledBack,
    Conflict, RecoveryRequired, ReidentityRequired, HeldPaused }
public enum RoleStage { Untouched, PreexistingTarget, ApplyIntent, Applied, RestoreIntent, Restored }

// PolicyIdentity must identify the OS application's policy namespace, not its display name.
// ImageIdentity is a verified executable/package identity, not merely "Spotify.exe".
public sealed record SpotifyProcess(int Pid, long StartTimeUtcTicks, string UserSid,
    string PolicyIdentity, string ImageIdentity, string Distribution)
{
    public bool SameApplication(SpotifyProcess other) =>
        UserSid == other.UserSid && PolicyIdentity == other.PolicyIdentity &&
        ImageIdentity == other.ImageIdentity && Distribution == other.Distribution;
    public bool WellFormed => Pid > 0 && StartTimeUtcTicks > 0 &&
        new[] { UserSid, PolicyIdentity, ImageIdentity, Distribution }.All(x => !string.IsNullOrWhiteSpace(x));
}

public sealed record BaseRenderEndpoint(string Id, string PolicyValue, string PnpOwnerIdentity,
    string DriverIdentity, bool TrustedBase, bool OrdinaryRender, bool Active)
{
    public bool Eligible => !string.IsNullOrWhiteSpace(Id) && !string.IsNullOrWhiteSpace(PolicyValue) && !string.IsNullOrWhiteSpace(PnpOwnerIdentity) &&
        !string.IsNullOrWhiteSpace(DriverIdentity) && TrustedBase && OrdinaryRender && Active;
}

public sealed record RouteRole(RenderRole Role, string? Original, RoleStage Stage);
public sealed record RouteRecord(int Schema, long Revision, Guid TransactionId,
    SpotifyProcess OriginalProcess, SpotifyProcess CurrentProcess, BaseRenderEndpoint Target,
    RouteStage Stage, RouteRole[] Roles, string? Issue, DateTimeOffset UpdatedAtUtc);
public sealed record RenderSession(SpotifyProcess Process, string SessionInstanceId,
    string EndpointId, bool Active);
public sealed record SessionObservation(bool CompleteForProcess, SpotifyProcess Process,
    DateTimeOffset ObservedAtUtc, RenderSession[] Sessions);

public interface IVerifiedSpotifyResolver
{
    // Reject an untrusted/ambiguous binary, unknown app-policy identity, or a different
    // process start time. Hold a process handle and recheck it at each operation.
    IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected);
}
public interface IBoundSpotifyPolicy : IDisposable
{
    SpotifyProcess Identity { get; }
    // Must return freshly verified identity or throw. A name/PID match is insufficient.
    SpotifyProcess CheckLiveIdentity();
    // Render-only, exact role. Values are opaque persisted-policy identifiers, which
    // can differ from the MMDevice endpoint IDs used by the session observer.
    // Null means the exact absent/default preference, not failure.
    // Failure must throw; never collapse a failed getter into null.
    string? Get(RenderRole role);
    // Must recheck the bound live process immediately before/after its native operation.
    // No global endpoint setter or ClearAll operation belongs in this interface.
    void Set(RenderRole role, string? endpoint);
}
public interface ISelectedEndpointVerifier
{
    // Fresh inventory/PnP evidence. Friendly-name matching is not a trust mechanism.
    BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected);
}
public interface ISessionObserver
{
    // Bounded observation. Enumerate the full verified Spotify process session set,
    // preserve session-instance IDs, and use actual endpoint IDs. No policy-as-proof.
    SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait);
}
public interface IDurableRouteJournal
{
    // One exclusive owner for the complete transaction operation. A successful Append
    // acknowledges a durable complete snapshot; failure prevents further policy writes.
    RouteRecord? ReadLatest();
    void Append(RouteRecord record);
}

public sealed class RouteBlockedException(string code, PhysicalOwnerDiagnostic? diagnostic = null) : Exception(code)
{
    public PhysicalOwnerDiagnostic? Diagnostic { get; } = diagnostic;
}
public sealed class JournalUnavailableException(string message, Exception? inner = null) : Exception(message, inner);
