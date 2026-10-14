namespace Folia.RouteObservation;

// Device-free sticky history used by the real native callback feed. A clean
// later snapshot cannot clear a foreign creation/activity or coverage gap.
internal sealed class SessionIsolationLedger
{
    private sealed record Scope(string Endpoint, uint Owner);
    private Scope? scope;
    private int violated, pending;
    private string? violationReason;
    internal string DiagnosticReason => Volatile.Read(ref scope) is null ? "not-armed" :
        Volatile.Read(ref violated) != 0 ? Volatile.Read(ref violationReason) ?? "violated" :
        Volatile.Read(ref pending) != 0 ? "pending-identity" : "isolated";
    private OwnedSilentRenderSession? silentLease;
    internal void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity)
    {
        if (Volatile.Read(ref scope) is not null || Interlocked.CompareExchange(ref silentLease, identity, null) is not null)
            throw new InvalidOperationException("OWNED_SILENT_RENDER_LEASE_ALREADY_BOUND");
    }
    internal bool Isolated => Volatile.Read(ref scope) is not null && Volatile.Read(ref violated) == 0 &&
        Volatile.Read(ref pending) == 0 && Volatile.Read(ref violated) == 0;
    internal void Arm(string endpoint, uint owner, IEnumerable<RawAudioSession> baseline)
    {
        if (string.IsNullOrWhiteSpace(endpoint) || owner == 0 || owner > int.MaxValue) throw new ArgumentException("INTERVAL_BINDING_INVALID");
        if (Interlocked.CompareExchange(ref scope, new(endpoint, owner), null) is not null)
            throw new InvalidOperationException("INTERVAL_ALREADY_ARMED");
        var rows = baseline.ToArray();
        if (silentLease is { } lease && (lease.EndpointId != endpoint || rows.Count(lease.Matches) != 1)) Violate();
        foreach (var row in rows) ObserveExisting(row);
    }
    internal bool BeginPending(string endpoint)
    {
        if (!Relevant(endpoint)) return false;
        Interlocked.Increment(ref pending); return true;
    }
    internal void EndPending() { if (Interlocked.Decrement(ref pending) < 0) { Discontinuity(); throw new InvalidOperationException("INTERVAL_PENDING_UNDERFLOW"); } }
    internal void ObserveExisting(RawAudioSession row)
    { if (Relevant(row.EndpointId) && ((row.State == AudioSessionState.Active && !Owned(row)) ||
        (silentLease?.SameInstance(row) == true && !silentLease.Matches(row)))) Violate(); }
    internal void ObserveCreated(RawAudioSession row)
    { if (Relevant(row.EndpointId) && !Owned(row)) Violate(); }
    internal void ObserveEvent(string endpoint, RawAudioSession? identity)
    { if (Relevant(endpoint) && (identity is null || !Owned(identity))) Violate(); }
    internal void Discontinuity(string reason = "coverage-discontinuity") { if (Volatile.Read(ref scope) is not null) Violate(reason); }
    internal bool PropertiesChanged(string? endpoint, string reason)
    {
        // A property update on another output does not remove our retained
        // capture session subscriptions. The observer still rescans all rows.
        var affectsCapture = string.IsNullOrEmpty(endpoint) || Relevant(endpoint);
        if (affectsCapture) Discontinuity(reason);
        return affectsCapture;
    }
    private bool Relevant(string endpoint) => Volatile.Read(ref scope)?.Endpoint == endpoint;
    private bool Owned(RawAudioSession row) => Volatile.Read(ref scope) is { } value &&
        row.EndpointId == value.Endpoint && (row.SystemSoundsHResult == 1 && row.ProcessIdHResult == 0 && row.ReportedProcessId == value.Owner ||
            silentLease?.Matches(row) == true);
    private void Violate(string reason = "foreign-or-invalid-session")
    {
        Interlocked.CompareExchange(ref violationReason, reason, null);
        Interlocked.Exchange(ref violated, 1);
    }
}
