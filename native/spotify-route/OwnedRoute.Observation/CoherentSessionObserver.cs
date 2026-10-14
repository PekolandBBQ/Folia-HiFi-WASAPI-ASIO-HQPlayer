using Folia.RouteResearch;

namespace Folia.RouteObservation;

// The observation is a point-in-time proof, never a lease on future routing.
// Production composition must separately qualify the concrete Windows feed.
public sealed class CoherentSessionObserver : ISessionObserver, IDisposable
{
    private readonly IReadOnlySessionFeed feed;
    private readonly ObservationOptions options;
    private readonly TimeProvider clock;
    private readonly SemaphoreSlim serial = new(1, 1);
    private readonly object events = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, IEndpointSessionFeed> endpoints = new(StringComparer.Ordinal);
    private IDisposable? registration;
    private long epoch, revision;
    private bool resetRequired = true, disposed;
    private SessionObservation? certifiedObservation;
    private (long Epoch, long Revision) certifiedStamp;
    private long certifiedAt;
    public string? LastIncompleteReason { get; private set; }
    public long Generation { get { lock (events) return epoch; } }
    // A caller about to restore one owned policy role can reject events that
    // arrived after the full scan. This is a final fence, not an OS write lock.
    public bool IsCurrentPublication(SessionObservation value)
    {
        if (!ReferenceEquals(value, certifiedObservation) || disposed || resetRequired) return false;
        var age = clock.GetElapsedTime(certifiedAt);
        if (age < TimeSpan.Zero || age > options.MaximumSnapshotAge || !Current(certifiedStamp)
            || !feed.IsPublicationQuiescent || !Current(certifiedStamp)) return false;
        lock (events) return ReferenceEquals(value, certifiedObservation) && Current(certifiedStamp) && !disposed;
    }

    public CoherentSessionObserver(IReadOnlySessionFeed feed, ObservationOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        this.feed = feed ?? throw new ArgumentNullException(nameof(feed));
        this.options = options ?? new();
        clock = timeProvider ?? TimeProvider.System;
        if (this.options.QuietPeriod <= TimeSpan.Zero || this.options.MaximumSnapshotAge <= TimeSpan.Zero ||
            this.options.PollInterval <= TimeSpan.Zero || this.options.QuietPeriod >= this.options.MaximumSnapshotAge)
            throw new ArgumentOutOfRangeException(nameof(options));
    }

    public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) =>
        Observe(process, maximumWait, CancellationToken.None);

    public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(process);
        if (maximumWait <= TimeSpan.Zero || maximumWait > TimeSpan.FromMinutes(1))
            throw new ArgumentOutOfRangeException(nameof(maximumWait));
        using var timeout = new CancellationTokenSource(maximumWait);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken,
            timeout.Token, lifetime.Token);
        var ct = linked.Token;
        var entered = false;
        var expected = process.Identity;
        RenderSession[] partial = [];
        LastIncompleteReason = null;
        try
        {
            serial.Wait(ct);
            entered = true;
            certifiedObservation = null;
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!expected.WellFormed) throw new RouteBlockedException("SESSION_PROCESS_IDENTITY_INVALID");
            RequireIdentity(process, expected);
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    if (NeedsReset()) StartEpoch(ct);
                    RequireIdentity(process, expected);
                    var before = Stamp();
                    var started = clock.GetTimestamp();
                    var active = Inventory(ct);
                    // All active render endpoints participate, including endpoints
                    // with no target rows. A missing endpoint cannot prove absence.
                    if (!endpoints.Keys.Order(StringComparer.Ordinal).SequenceEqual(active))
                    {
                        foreach (var id in endpoints.Keys.Except(active, StringComparer.Ordinal).ToArray())
                        { endpoints[id].Dispose(); endpoints.Remove(id); }
                        foreach (var id in active.Where(id => !endpoints.ContainsKey(id)))
                        {
                            var generation = before.Epoch;
                            var endpoint = feed.OpenEndpoint(id, e => Changed(generation, e), ct);
                            if (endpoint.EndpointId != id) { endpoint.Dispose(); throw new InvalidDataException("ENDPOINT_REGISTRATION_ID_MISMATCH"); }
                            endpoints.Add(id, endpoint);
                        }
                    }
                    var raw = new List<RawAudioSession>();
                    foreach (var id in active)
                    {
                        ct.ThrowIfCancellationRequested();
                        var rows = endpoints[id].ReadSessions(ct);
                        if (rows.Length > 65536) throw new InvalidDataException("SESSION_COUNT_LIMIT");
                        if (rows.Any(row => row.EndpointId != id))
                            throw new InvalidDataException("SESSION_ENDPOINT_MISMATCH");
                        raw.AddRange(rows);
                    }
                    if (!active.SequenceEqual(Inventory(ct)))
                    { Rescan("ENDPOINT_INVENTORY_CHANGED"); Pause(ct); continue; }
                    partial = Classify(raw, expected, out var ambiguity);
                    if (ambiguity != null) { LastIncompleteReason = ambiguity; Pause(ct); continue; }
                    RequireIdentity(process, expected);
                    if (!Current(before)) { LastIncompleteReason = "SESSION_EVENTS_DURING_ENUMERATION"; Pause(ct); continue; }

                    // Wait for a bounded quiet interval, then reread every retained
                    // control. This detects state/identity changes even when a
                    // callback was delayed. Never certify an aged first scan.
                    Wait(options.QuietPeriod, ct);
                    if (!Current(before)) { LastIncompleteReason = "SESSION_EVENTS_DURING_STABILITY_WINDOW"; continue; }
                    var confirmed = new List<RawAudioSession>();
                    foreach (var id in active)
                    {
                        var rows = endpoints[id].ReadSessions(ct);
                        if (rows.Length > 65536 || rows.Any(row => row.EndpointId != id))
                            throw new InvalidDataException("SESSION_CONFIRMATION_INVALID");
                        confirmed.AddRange(rows);
                    }
                    if (!SameRows(raw, confirmed) || !active.SequenceEqual(Inventory(ct)))
                    { Rescan("SESSION_RESCAN_CHANGED"); continue; }
                    RequireIdentity(process, expected);
                    ct.ThrowIfCancellationRequested();
                    // Take the timestamp before the final revision fence. An
                    // event during clock access must invalidate this candidate.
                    var candidate = new SessionObservation(true, expected, clock.GetUtcNow(), partial);
                    var age = clock.GetElapsedTime(started);
                    if (age < TimeSpan.Zero || age > options.MaximumSnapshotAge)
                    { LastIncompleteReason = "SESSION_SNAPSHOT_STALE"; continue; }
                    if (!Current(before)) continue;
                    if (!feed.IsPublicationQuiescent)
                    { LastIncompleteReason = "SESSION_CALLBACK_PUBLICATION_PENDING"; continue; }
                    lock (events)
                    {
                        if (before != (Volatile.Read(ref epoch), Volatile.Read(ref revision)) || Volatile.Read(ref resetRequired)) continue;
                        // The publication sample plus unchanged revision is the
                        // final fence. Callbacks starting afterward are future
                        // changes; consumers must request fresh proof again.
                        LastIncompleteReason = null;
                        certifiedAt = clock.GetTimestamp();
                        if (!Current(before)) continue;
                        certifiedStamp = before; certifiedObservation = candidate;
                        return candidate;
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (RouteBlockedException) { throw; }
                catch (Exception e) when (e is not OutOfMemoryException)
                { Invalidate("SESSION_FEED_FAILURE:" + e.GetType().Name); Pause(ct); }
            }
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested &&
            !cancellationToken.IsCancellationRequested && !lifetime.IsCancellationRequested)
        {
            LastIncompleteReason ??= "SESSION_OBSERVATION_TIMEOUT";
            // Canceled feed work cannot contribute to any later generation.
            Invalidate(LastIncompleteReason);
            return new(false, expected, clock.GetUtcNow(), partial);
        }
        finally
        {
            if (entered)
            {
                if (ct.IsCancellationRequested) Invalidate(LastIncompleteReason ?? "SESSION_OBSERVATION_CANCELLED");
                serial.Release();
            }
        }
    }

    private string[] Inventory(CancellationToken ct)
    {
        var ids = feed.EnumerateActiveRenderEndpoints(ct);
        if (ids.Length > 4096 || ids.Any(string.IsNullOrWhiteSpace) || ids.Distinct(StringComparer.Ordinal).Count() != ids.Length)
            throw new InvalidDataException("ENDPOINT_INVENTORY_INVALID");
        return ids.Order(StringComparer.Ordinal).ToArray();
    }
    private static void RequireIdentity(IBoundSpotifyPolicy process, SpotifyProcess expected)
    {
        if (process.Identity != expected || process.CheckLiveIdentity() != expected)
            throw new RouteBlockedException("SESSION_PROCESS_GENERATION_CHANGED");
    }
    private static RenderSession[] Classify(IEnumerable<RawAudioSession> rows, SpotifyProcess expected,
        out string? ambiguity)
    {
        ambiguity = null;
        var target = new List<RenderSession>();
        var keys = new HashSet<(string, string)>();
        foreach (var row in rows)
        {
            if (string.IsNullOrWhiteSpace(row.SessionInstanceId) || string.IsNullOrWhiteSpace(row.EndpointId) ||
                !Enum.IsDefined(row.State) || !keys.Add((row.EndpointId, row.SessionInstanceId)))
            { ambiguity = "SESSION_FIELDS_OR_DUPLICATES_INVALID"; continue; }
            // Expired streams cannot render. System sounds are excluded only by
            // exact S_OK on this same control. Unknown/multi-process rows block
            // the proof even if their creator PID happens to be somebody else.
            if (row.State == AudioSessionState.Expired || row.SystemSoundsHResult == 0) continue;
            // A stopped cross-process session cannot render and cannot identify
            // Spotify's audio process. Keep its native row/subscription for the
            // stability and capture-isolation fences, but do not let an unrelated
            // paused app prevent discovering Spotify. Active ambiguous rows below
            // still block; a transition invalidates this publication.
            if (row.State == AudioSessionState.Inactive && row.SystemSoundsHResult == 1
                && row.ProcessIdHResult == RawAudioSession.NoSingleProcess) continue;
            if (row.SystemSoundsHResult != 1 || row.ProcessIdHResult != 0 ||
                row.ReportedProcessId == 0 || row.ReportedProcessId > int.MaxValue)
            { ambiguity = "SESSION_OWNERSHIP_AMBIGUOUS"; continue; }
            if (row.ReportedProcessId == expected.Pid)
                target.Add(new(expected, row.SessionInstanceId, row.EndpointId, row.State == AudioSessionState.Active));
        }
        return target.OrderBy(row => row.EndpointId, StringComparer.Ordinal)
            .ThenBy(row => row.SessionInstanceId, StringComparer.Ordinal).ToArray();
    }
    private static bool SameRows(IEnumerable<RawAudioSession> left, IEnumerable<RawAudioSession> right) =>
        left.OrderBy(x => x.EndpointId, StringComparer.Ordinal).ThenBy(x => x.SessionInstanceId, StringComparer.Ordinal)
        .SequenceEqual(right.OrderBy(x => x.EndpointId, StringComparer.Ordinal).ThenBy(x => x.SessionInstanceId, StringComparer.Ordinal));
    private void StartEpoch(CancellationToken ct)
    {
        long generation;
        lock (events) { generation = Interlocked.Increment(ref epoch); Interlocked.Increment(ref revision); resetRequired = true; }
        // Increment first, so queued callbacks from disposed sinks cannot certify
        // or invalidate a later generation. Cleanup is never in a callback.
        registration?.Dispose(); registration = null;
        foreach (var item in endpoints.Values) item.Dispose();
        endpoints.Clear();
        lock (events) resetRequired = false;
        try { registration = feed.RegisterEndpointNotifications(e => Changed(generation, e), ct); }
        catch { Invalidate("ENDPOINT_NOTIFICATION_REGISTRATION_FAILED"); throw; }
    }
    private void Changed(long generation, SessionFeedEvent change)
    {
        // Runs synchronously at native callback entry. Never block a WASAPI
        // callback on an observer lock, COM method, queue drain or disposal.
        if (generation != Volatile.Read(ref epoch) || Volatile.Read(ref disposed)) return;
        if (change.Kind is not (SessionFeedEventKind.SessionChanged or SessionFeedEventKind.DefaultChanged or SessionFeedEventKind.EndpointPropertyChanged or SessionFeedEventKind.EndpointInventoryChanged)) Volatile.Write(ref resetRequired, true);
        Interlocked.Increment(ref revision);
        LastIncompleteReason = change.Kind == SessionFeedEventKind.EventLoss ? "SESSION_EVENT_LOSS" : "SESSION_FEED_CHANGED";
    }
    private bool NeedsReset() => Volatile.Read(ref resetRequired);
    private (long Epoch, long Revision) Stamp() => (Volatile.Read(ref epoch), Volatile.Read(ref revision));
    private bool Current((long Epoch, long Revision) value)
    { return value == Stamp() && !Volatile.Read(ref resetRequired); }
    private void Invalidate(string reason)
    { Volatile.Write(ref resetRequired, true); Interlocked.Increment(ref revision); LastIncompleteReason = reason; }
    // A changed snapshot needs another complete scan, not a gap in retained
    // subscriptions. Native topology/event-loss callbacks still require reset.
    private void Rescan(string reason)
    { Interlocked.Increment(ref revision); LastIncompleteReason = reason; }
    private void Pause(CancellationToken ct) => Wait(options.PollInterval, ct);
    private static void Wait(TimeSpan interval, CancellationToken ct)
    { if (ct.WaitHandle.WaitOne(interval)) ct.ThrowIfCancellationRequested(); }
    public void Dispose()
    {
        lifetime.Cancel();
        serial.Wait();
        try
        {
            if (disposed) return;
            lock (events) { disposed = true; Interlocked.Increment(ref epoch); Interlocked.Increment(ref revision); resetRequired = true; }
            registration?.Dispose(); registration = null;
            foreach (var endpoint in endpoints.Values) endpoint.Dispose();
            endpoints.Clear();
            feed.Dispose();
        }
        finally { serial.Release(); }
    }
}
