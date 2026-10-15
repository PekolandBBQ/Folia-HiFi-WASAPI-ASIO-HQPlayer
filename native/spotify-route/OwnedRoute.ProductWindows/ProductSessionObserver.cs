using Folia.RouteObservation;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

// The coherent observer certifies the full native scan, although its public
// projection contains only the bound Spotify process. Keep the raw rows from
// that SAME final publication fence to rule out other writers on our cable.
// A diagnostic snapshot can never enter this path or become complete evidence.
internal sealed class ProductSessionObserver : ISessionObserver, IDisposable
{
    private readonly FencedFeed feed;
    private readonly CoherentSessionObserver observer;
    private readonly string render;
    private HashSet<uint>? audioCandidates;
    private Action? environmentGuard;
    private Action? pausedEnvironmentGuard;
    private bool intervalArmed;
    private SpotifyProcess? lastCertifiedProcess;
    private bool lastCaptureEligible;
    private OwnedSilentRenderSession? silentLease;
    private Func<bool>? silentLeaseLive;
    private SessionObservation? restoreQuiescence;
    internal void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity, Func<bool> live)
    {
        if (intervalArmed || silentLease is not null || identity.EndpointId != render)
            throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_INVALID");
        feed.BindOwnedSilentRenderSession(identity); silentLease = identity; silentLeaseLive = live;
    }
    internal ProductSessionObserver(IReadOnlySessionFeed source, string selectedRender, ObservationOptions? options = null, TimeProvider? timeProvider = null)
    { feed = new(source); observer = new(feed, options, timeProvider); render = selectedRender; }
    internal RawAudioSession[] LastCertifiedInventory { get; private set; } = [];
    internal void BindAudioProcessSet(IEnumerable<int> candidatePids) => audioCandidates = candidatePids.Select(pid => checked((uint)pid)).ToHashSet();
    internal void BindEnvironmentGuard(Action guard, Action? pauseGuard = null)
    { environmentGuard = guard; pausedEnvironmentGuard = pauseGuard ?? guard; }
    internal bool IntervalIsolated
    {
        get
        {
            var leaseLive = silentLease is null || silentLeaseLive?.Invoke() == true;
            var result = intervalArmed && leaseLive && (ProcessCaptureRouting.Enabled || feed.IntervalIsolated);
            if (!result)
            {
                var path = Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
                if (!string.IsNullOrWhiteSpace(path))
                    try { File.AppendAllText(path, System.Text.Json.JsonSerializer.Serialize(new {
                        at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), pid = Environment.ProcessId,
                        stage = "route.observer-interval-unconfirmed", intervalArmed, leaseLive
                    }) + Environment.NewLine); } catch { }
            }
            return result;
        }
    }
    internal bool CurrentCaptureEligible => lastCertifiedProcess is not null && lastCaptureEligible;
    internal ISessionObserver ForPause => new PauseObserver(this);
    internal IRestoreQuiescenceObserver ForEmptyRestore => new RestoreObserver(this);
    internal void RequireCurrentRestoreQuiescence()
    {
        if (restoreQuiescence is null || !observer.IsCurrentPublication(restoreQuiescence))
            throw new RouteBlockedException("EMPTY_PLAYER_NATIVE_QUIESCENCE_EXPIRED");
    }
    internal void BeginIsolation(SpotifyProcess process)
    {
        if (intervalArmed) throw new RouteBlockedException("CAPTURE_INTERVAL_ALREADY_ARMED");
        if (lastCertifiedProcess != process || !lastCaptureEligible) throw new RouteBlockedException("FRESH_CAPTURE_INTERVAL_BASELINE_REQUIRED");
        environmentGuard?.Invoke();
        feed.BeginIsolation(render, checked((uint)process.Pid));
        intervalArmed = true;
        if (!IntervalIsolated) throw new RouteBlockedException("CAPTURE_INTERVAL_NOT_ISOLATED");
    }
    internal string? LastIncompleteReason => observer.LastIncompleteReason;
    // Discovery may classify every candidate from one coherent full inventory.
    // This checks the original publication; it does not refresh its timestamp.
    internal void RequireCurrentDiscovery(SessionObservation publication)
    {
        if (!publication.CompleteForProcess || !observer.IsCurrentPublication(publication))
            throw new RouteBlockedException("COMPLETE_SPOTIFY_DISCOVERY_REQUIRED");
    }
    public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) => ObserveCore(process, maximumWait, true);
    private SessionObservation ObserveCore(IBoundSpotifyPolicy process, TimeSpan maximumWait, bool requireCaptureEligible)
    {
        using var coldTiming=ColdTiming.Scope("route.Observe");
        LastCertifiedInventory = [];
        restoreQuiescence = null;
        lastCertifiedProcess = null;
        lastCaptureEligible = false;
        (requireCaptureEligible ? environmentGuard : pausedEnvironmentGuard)?.Invoke();
        feed.BeginObservation();
        var result = observer.Observe(process, maximumWait);
        if (!result.CompleteForProcess) { Rejected("native-publication", result); return result; }
        var inventory = feed.CertifiedRows;
        if (inventory is null) { Rejected("missing-certified-inventory", result); return result with { CompleteForProcess = false }; }
        if (audioCandidates is not null && inventory.Any(row => row.State != AudioSessionState.Expired &&
            row.SystemSoundsHResult == 1 && row.ProcessIdHResult == 0 &&
            row.ReportedProcessId != process.Identity.Pid && audioCandidates.Contains(row.ReportedProcessId)))
        { Rejected("another-spotify-audio-process", result, inventory); return result with { CompleteForProcess = false }; }
        // Endpoint-mix capture must reject every foreign writer, including system
        // sounds. Process capture excludes them in Windows and only retains the
        // Spotify ownership and live format-keeper checks below.
        lastCaptureEligible = ProcessCaptureRouting.Enabled || !inventory.Any(row => row.EndpointId == render && row.State == AudioSessionState.Active &&
            (row.SystemSoundsHResult != 1 || row.ProcessIdHResult != 0 || row.ReportedProcessId != process.Identity.Pid) &&
            silentLease?.Matches(row) != true);
        if (silentLease is { } lease)
            lastCaptureEligible &= silentLeaseLive?.Invoke() == true && inventory.Count(lease.Matches) == 1;
        if (requireCaptureEligible && !lastCaptureEligible)
        { Rejected("capture-baseline", result, inventory); return result with { CompleteForProcess = false }; }
        LastCertifiedInventory = inventory;
        (requireCaptureEligible ? environmentGuard : pausedEnvironmentGuard)?.Invoke();
        lastCertifiedProcess = process.Identity;
        return result;
    }
    // Optional counts distinguish a pending publication from a missing keeper without exposing identities.
    private void Rejected(string reason, SessionObservation result, RawAudioSession[]? rows = null)
    {
        var logPath = Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
        if (string.IsNullOrWhiteSpace(logPath)) return;
        try { File.AppendAllText(logPath, System.Text.Json.JsonSerializer.Serialize(new {
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), stage = "route.observation-rejected", reason,
            incompleteReason = observer.LastIncompleteReason, complete = result.CompleteForProcess,
            targetRows = result.Sessions.Length, targetActive = result.Sessions.Count(x => x.Active),
            inventoryRows = rows?.Length, baseRows = rows?.Count(x => x.EndpointId == render),
            baseActive = rows?.Count(x => x.EndpointId == render && x.State == AudioSessionState.Active),
            keeperBound = silentLease is not null, keeperLive = silentLeaseLive?.Invoke(),
            keeperMatches = silentLease is { } lease ? rows?.Count(lease.Matches) : null,
            keeperRows = silentLease is { } expected ? rows?.Where(row => row.EndpointId == expected.EndpointId
                && (expected.SameInstance(row) || row.ReportedProcessId == expected.ProcessId)).Select(row => new {
                    sameInstance = expected.SameInstance(row), state = row.State.ToString(),
                    samePid = row.ReportedProcessId == expected.ProcessId, row.ProcessIdHResult,
                    row.SystemSoundsHResult, sameGroup = row.GroupingId == expected.GroupingId, row.GroupingHResult
                }).ToArray() : null
        }) + Environment.NewLine); } catch { }
    }
    internal void StopForHeldPause()
    {
        observer.Dispose(); RequireStopped();
    }
    internal void RequireStopped()
    {
        if (!feed.IsStopped) throw new RouteBlockedException("ROUTE_OBSERVER_STOP_UNCONFIRMED");
    }
    public void Dispose() => observer.Dispose();
    private sealed class PauseObserver(ProductSessionObserver owner) : ISessionObserver
    {
        public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) => owner.ObserveCore(process, maximumWait, false);
    }
    private sealed class RestoreObserver(ProductSessionObserver owner) : IRestoreQuiescenceObserver
    {
        public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) => owner.ObserveCore(process, maximumWait, false);
        public SessionObservation ObserveRestoreQuiescence(IBoundSpotifyPolicy process, TimeSpan maximumWait)
        {
            var value = owner.ObserveCore(process, maximumWait, false);
            if (!value.CompleteForProcess || value.Process != process.Identity
                || value.Sessions.Any(row => row.Process != process.Identity || row.Active)
                || owner.LastCertifiedInventory.Any(row => row.EndpointId == owner.render && row.State == AudioSessionState.Active))
                throw new RouteBlockedException("EMPTY_PLAYER_NATIVE_QUIESCENCE_UNCONFIRMED");
            owner.restoreQuiescence = value;
            return value;
        }
    }

    private sealed class FencedFeed(IReadOnlySessionFeed inner) : IReadOnlySessionFeed
    {
        // Only the serialized observer thread writes these collections. Native
        // callbacks forward directly to the observer's nonblocking invalidation.
        private readonly Dictionary<string, Endpoint> endpoints = new(StringComparer.Ordinal);
        internal RawAudioSession[]? CertifiedRows { get; private set; }
        internal void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity)
        {
            if (inner is not IReadOnlySessionIsolationFeed isolation) throw new RouteBlockedException("SESSION_INTERVAL_FEED_REQUIRED");
            isolation.BindOwnedSilentRenderSession(identity);
        }
        public bool IsStopped => inner.IsStopped;
        internal bool IntervalIsolated => inner is IReadOnlySessionIsolationFeed isolation && isolation.IntervalIsolated;
        internal void BeginIsolation(string endpoint, uint pid)
        {
            if (inner is not IReadOnlySessionIsolationFeed isolation) throw new RouteBlockedException("SESSION_INTERVAL_FEED_REQUIRED");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            isolation.BeginIsolation(endpoint, pid, timeout.Token);
        }
        internal void BeginObservation() => CertifiedRows = null;
        public bool IsPublicationQuiescent
        {
            get
            {
                if (!inner.IsPublicationQuiescent) return false;
                var rows = endpoints.Values.SelectMany(endpoint => endpoint.Rows).ToArray();
                if (!inner.IsPublicationQuiescent) return false;
                CertifiedRows = rows;
                // The coherent observer checks its event revision after this
                // getter. A callback during the copy invalidates the candidate.
                return true;
            }
        }
        public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed, CancellationToken ct) =>
            inner.RegisterEndpointNotifications(changed, ct);
        public string[] EnumerateActiveRenderEndpoints(CancellationToken ct) => inner.EnumerateActiveRenderEndpoints(ct);
        public IEndpointSessionFeed OpenEndpoint(string id, Action<SessionFeedEvent> changed, CancellationToken ct)
        {
            var endpoint = new Endpoint(this, inner.OpenEndpoint(id, changed, ct));
            endpoints.Add(id, endpoint); return endpoint;
        }
        public void Dispose() { inner.Dispose(); endpoints.Clear(); CertifiedRows = null; }
        private sealed class Endpoint(FencedFeed owner, IEndpointSessionFeed inner) : IEndpointSessionFeed
        {
            internal RawAudioSession[] Rows { get; private set; } = [];
            public string EndpointId => inner.EndpointId;
            public RawAudioSession[] ReadSessions(CancellationToken ct)
            { var rows = inner.ReadSessions(ct); Rows = rows.ToArray(); return rows; }
            public void Dispose()
            {
                if (owner.endpoints.TryGetValue(EndpointId, out var current) && ReferenceEquals(current, this))
                    owner.endpoints.Remove(EndpointId);
                inner.Dispose();
            }
        }
    }
}
