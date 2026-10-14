using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteObservation;
using Folia.RouteResearch;
using Folia.RouteRunner;

var passed = 0;
var group = Guid.Parse("26377ba7-2d95-407a-b2b7-7131377305c2");
var own = new OwnedSilentRenderSession("render", "capture-instance", group, 20);
var keeper = new RawAudioSession("capture-instance", "render", AudioSessionState.Active, 20, 0, 1, group, 0);
var spotify = new RawAudioSession("spotify-instance", "render", AudioSessionState.Inactive, 12, 0, 1);
var bound = new Bound();
void Check(bool ok, string reason) { if (!ok) throw new Exception(reason); }
void Run(string name, Action action) { action(); passed++; Console.WriteLine("PASS " + name); }
void Fails(Action action) { try { action(); } catch (Exception) { return; } throw new Exception("Expected failure"); }
ProductSessionObserver Observer(Feed feed) => new(feed, "render", new ObservationOptions {
    QuietPeriod = TimeSpan.FromMilliseconds(1), PollInterval = TimeSpan.FromMilliseconds(1), MaximumSnapshotAge = TimeSpan.FromMilliseconds(100) });
SessionIsolationLedger Armed(params RawAudioSession[] extra)
{
    var ledger = new SessionIsolationLedger(); ledger.BindOwnedSilentRenderSession(own);
    ledger.Arm("render", 12, new[] { spotify, keeper }.Concat(extra)); return ledger;
}
Dictionary<string, object> Proof() => new() { ["captureSession"] = "session-1", ["captureGeneration"] = 7,
    ["endpointId"] = "render", ["sessionInstanceId"] = "capture-instance", ["groupingId"] = group.ToString("D"),
    ["processId"] = 20, ["startedAtUtcTicks"] = "639271242001234567" };
OwnedSilentRenderLeaseProof? Parse(object proof, string session = "session-1", string endpoint = "render") =>
    OwnedSilentRenderLeaseProof.Read(JsonSerializer.SerializeToElement(new { ownedSilentRenderLease = proof }), session, endpoint);

Run("unrelated output property keeps capture history but capture or unknown changes revoke it", () => {
    var ledger = Armed();
    Check(!ledger.PropertiesChanged("speakers", "test-property") && ledger.Isolated, "Unrelated property poisoned capture");
    Check(ledger.PropertiesChanged("render", "test-property") && !ledger.Isolated, "Capture property was ignored");
    ledger.PropertiesChanged("speakers", "test-property");
    Check(!ledger.Isolated, "Later property cleared sticky loss");
    var unknown = Armed(); Check(unknown.PropertiesChanged(null, "test-property") && !unknown.Isolated, "Unknown endpoint passed");
});

Run("r25-to-r26 active keeper needs exact attestation before the arm baseline", () => {
    using var feed = new Feed([spotify, keeper]); using var observer = Observer(feed);
    Check(observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Pause became invalid");
    Check(!observer.CurrentCaptureEligible, "Unattested active writer was accepted");
    Fails(() => observer.BeginIsolation(bound.Identity));
    observer.BindOwnedSilentRenderSession(own, () => true);
    Check(observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess && observer.CurrentCaptureEligible, "Exact active keeper did not establish baseline");
    observer.BeginIsolation(bound.Identity); Check(observer.IntervalIsolated, "Could not arm with exact keeper");
    feed.Rows = [spotify with { State = AudioSessionState.Active }, keeper];
    Check(observer.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Spotify resume rejected while exact keeper stayed active");
});
Run("same PID second active session remains an external writer", () => {
    using var feed = new Feed([spotify, keeper, keeper with { SessionInstanceId = "other-session" }]); using var observer = Observer(feed);
    observer.BindOwnedSilentRenderSession(own, () => true);
    Check(!observer.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "PID-wide exception admitted second session");
    Check(!Armed(keeper with { SessionInstanceId = "other-session" }).Isolated, "Ledger admitted second same-PID writer");
});
foreach (var change in new[] { keeper with { EndpointId = "other-endpoint" }, keeper with { SessionInstanceId = "other-instance" },
    keeper with { GroupingId = Guid.NewGuid() }, keeper with { GroupingHResult = null }, keeper with { GroupingHResult = -1 },
    keeper with { ReportedProcessId = 21 }, keeper with { ProcessIdHResult = RawAudioSession.NoSingleProcess }, keeper with { SystemSoundsHResult = 0 },
    keeper with { State = AudioSessionState.Inactive }, keeper with { State = AudioSessionState.Expired } })
    Run("exact lease rejects changed " + change, () => Check(!own.Matches(change), "Altered identity passed"));
Run("missing or inactive keeper cannot preserve a live-process exception", () => {
    foreach (var rows in new RawAudioSession[][] { [spotify], [spotify, keeper with { State = AudioSessionState.Inactive }] }) {
        using var feed = new Feed(rows); using var observer = Observer(feed); observer.BindOwnedSilentRenderSession(own, () => true);
        Check(!observer.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Absent/inactive keeper preserved readiness");
        Check(observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Restoration pause proof depends on keeper survival");
    }
});
Run("lost helper process revokes snapshot and armed interval", () => {
    var alive = true; using var feed = new Feed([spotify, keeper]); using var observer = Observer(feed);
    observer.BindOwnedSilentRenderSession(own, () => alive);
    observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)); observer.BeginIsolation(bound.Identity);
    alive = false; Check(!observer.IntervalIsolated, "Dead helper retained interval permission");
    Check(!observer.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Dead helper retained snapshot permission");
    Check(observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)).CompleteForProcess, "Dead helper blocked restoration pause proof");
});
Run("keeper Stop or grouping change permanently revokes interval", () => {
    foreach (var changed in new[] { keeper with { State = AudioSessionState.Inactive }, keeper with { State = AudioSessionState.Expired },
        keeper with { GroupingHResult = null }, keeper with { GroupingId = Guid.NewGuid() } }) {
        var ledger = Armed(); ledger.ObserveEvent("render", changed); ledger.ObserveExisting(keeper);
        Check(!ledger.Isolated, "Clean later row cleared revoked lease");
    }
});
Run("late foreign creation invalidates even after its audio has ended", () => {
    var ledger = Armed(); ledger.ObserveCreated(keeper with { SessionInstanceId = "late", State = AudioSessionState.Inactive });
    ledger.ObserveExisting(keeper); Check(!ledger.Isolated, "Late inactive burst was forgotten");
});
Run("owned exact duplicate callback does not authorize another instance", () => {
    var ledger = Armed(); ledger.ObserveCreated(keeper); Check(ledger.Isolated, "Exact baseline duplicate was rejected");
    ledger.ObserveCreated(keeper with { SessionInstanceId = "new-instance" }); Check(!ledger.Isolated, "New keeper instance inherited old permission");
});
Run("pending publication and event loss remain fail closed", () => {
    var ledger = Armed(); Check(ledger.BeginPending("render") && !ledger.Isolated, "Pending native creation remained ready");
    ledger.EndPending(); Check(ledger.Isolated, "Completed empty pending fence stuck");
    ledger.Discontinuity(); Check(!ledger.Isolated, "Event loss bypassed by silent keeper");
});
Run("old generation cannot replace an already-bound keeper", () => {
    var ledger = Armed(); Fails(() => ledger.BindOwnedSilentRenderSession(own with { SessionInstanceId = "next" }));
    using var feed = new Feed([spotify, keeper]); using var observer = Observer(feed);
    observer.BindOwnedSilentRenderSession(own, () => true); Fails(() => observer.BindOwnedSilentRenderSession(own, () => true));
});
Run("wire preserves exact process ticks and independent capture generation", () => {
    var proof = Parse(Proof())!; Check(proof.CaptureGeneration == 7 && proof.StartedAtUtcTicks == 639271242001234567, "Lost capture generation or ticks precision");
    Fails(() => Parse(Proof(), "session-2")); Fails(() => Parse(Proof(), endpoint: "other"));
});
Run("null or absent proof grants no exception", () => {
    Check(OwnedSilentRenderLeaseProof.Read(JsonSerializer.SerializeToElement(new { }), "session-1", "render") is null, "Missing proof created a grant");
    Check(OwnedSilentRenderLeaseProof.Read(JsonSerializer.SerializeToElement(new { ownedSilentRenderLease = (object?)null }), "session-1", "render") is null, "Null proof created a grant");
    var ledger = new SessionIsolationLedger(); ledger.Arm("render", 12, [spotify, keeper]); Check(!ledger.Isolated, "Null proof granted all helper sessions");
});
Run("unknown, duplicate, missing, oversized and invalid wire fields reject", () => {
    var extra = Proof(); extra["allowAnyProcess"] = true; Fails(() => Parse(extra));
    var missing = Proof(); missing.Remove("groupingId"); Fails(() => Parse(missing));
    foreach (var (key, value) in new (string, object)[] { ("captureGeneration", 0), ("processId", 0), ("groupingId", Guid.Empty.ToString()),
        ("startedAtUtcTicks", "0"), ("startedAtUtcTicks", "1e18"), ("sessionInstanceId", new string('x', 4097)) }) {
        var invalid = Proof(); invalid[key] = value; Fails(() => Parse(invalid));
    }
    var json = JsonSerializer.Serialize(new { ownedSilentRenderLease = Proof() }).Replace("\"processId\":20", "\"processId\":20,\"processId\":20");
    using var doc = JsonDocument.Parse(json); Fails(() => OwnedSilentRenderLeaseProof.Read(doc.RootElement, "session-1", "render"));
});
Run("held pause requires confirmed observer stop and does not reuse retired ledger", () => {
    var old = new Feed([spotify, keeper]); var observer = Observer(old);
    observer.BindOwnedSilentRenderSession(own, () => true); observer.ForPause.Observe(bound, TimeSpan.FromSeconds(1)); observer.BeginIsolation(bound.Identity);
    observer.StopForHeldPause(); Check(old.IsStopped, "Dispose completion not checked");
    using var next = new Feed([spotify, keeper]); using var fresh = Observer(next);
    fresh.BindOwnedSilentRenderSession(own, () => true); fresh.ForPause.Observe(bound, TimeSpan.FromSeconds(1)); fresh.BeginIsolation(bound.Identity);
    old.Poison(); Check(fresh.IntervalIsolated, "Late retired feed event contaminated new interval");
});
Run("observer stop timeout cannot claim indefinite held-pause quiescence", () => {
    using var feed = new Feed([spotify, keeper]) { StopCompletes = false }; using var observer = Observer(feed);
    Fails(() => observer.StopForHeldPause()); Check(!feed.IsStopped, "Stalled native worker was claimed stopped");
});
passed += ServiceBoundary.Run();
Console.WriteLine($"Executed render-lease boundary tests: {passed} passed. Device-free mock feed and policy only; no Windows APIs executed.");

sealed class Bound : IBoundSpotifyPolicy
{
    public SpotifyProcess Identity { get; } = new(12, 639271242000000000, "user", "spotify-policy", "spotify-image", "desktop");
    public SpotifyProcess CheckLiveIdentity() => Identity;
    public string? Get(RenderRole role) => throw new Exception("No policy reads in this test");
    public void Set(RenderRole role, string? endpoint) => throw new Exception("No policy writes in this test");
    public void Dispose() { }
}
sealed class Feed(RawAudioSession[] rows) : IReadOnlySessionFeed, IReadOnlySessionIsolationFeed
{
    internal RawAudioSession[] Rows = rows;
    private readonly SessionIsolationLedger ledger = new();
    public bool IsPublicationQuiescent => true;
    public bool StopCompletes = true;
    public bool IsStopped { get; private set; }
    public void Poison() => ledger.Discontinuity();
    public bool IntervalIsolated => ledger.Isolated;
    public void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity) => ledger.BindOwnedSilentRenderSession(identity);
    public void BeginIsolation(string endpoint, uint pid, CancellationToken ct) => ledger.Arm(endpoint, pid, Rows);
    public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed, CancellationToken ct) => new Empty();
    public string[] EnumerateActiveRenderEndpoints(CancellationToken ct) => ["render"];
    public IEndpointSessionFeed OpenEndpoint(string id, Action<SessionFeedEvent> changed, CancellationToken ct) => new Endpoint(this, id);
    public void Dispose() { IsStopped = StopCompletes; }
    private sealed class Endpoint(Feed owner, string id) : IEndpointSessionFeed
    {
        public string EndpointId => id;
        public RawAudioSession[] ReadSessions(CancellationToken ct) => owner.Rows.ToArray();
        public void Dispose() { }
    }
    private sealed class Empty : IDisposable { public void Dispose() { } }
}
