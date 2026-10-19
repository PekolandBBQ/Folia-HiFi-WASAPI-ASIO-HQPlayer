using Folia.Capture;
using Folia.ProductRoute;
using Folia.RouteObservation;
using Folia.RouteResearch;
using Folia.RouteRunner;

var passed = 0;
void Test(string name, Action body) { body(); passed++; Console.WriteLine("PASS " + name); }
void Require(bool value) { if (!value) throw new Exception("Assertion failed"); }
void Block(string code, Action body)
{ try { body(); } catch (RouteBlockedException error) when (error.Message == code) { return; } throw new Exception("Expected " + code); }
var process = new SpotifyProcess(101, 12345, "sid", "policy", "image", "desktop");
var other = process with { Pid = 102, StartTimeUtcTicks = 12346 };
SessionObservation Observation(SpotifyProcess identity, params RenderSession[] rows) => new(true, identity, DateTimeOffset.UtcNow, rows);
RenderSession Session(SpotifyProcess identity, string endpoint = "physical", bool active = false) => new(identity, "session-" + identity.Pid, endpoint, active);
var cable = new BaseCableIdentityEvidence("verified", "owner");
EndpointInfo Endpoint(string id, uint flow, string owner = "owner", uint form = 1) =>
    new(id, "untrusted friendly name", 1, flow, form, "instance", cable with { OwnerInstanceId = owner }, flow == 0 ? "opaque-policy" : null, 48000, 2);
Test("fresh paused discovery reuse requires exact selection and at most five seconds", () => {
    var selection = new RouteSelection("capture", "render");
    var discovery = new ProductDiscovery(process, new("render", "raw", "pnp", "driver", true, true, true),
        selection, [null, null, null], true, true, true, true, true, true);
    Require(WindowsProductBackend.CanReusePausedInspection(discovery, selection, TimeSpan.FromSeconds(5)));
    Require(!WindowsProductBackend.CanReusePausedInspection(discovery, selection, TimeSpan.FromMilliseconds(5001)));
    Require(!WindowsProductBackend.CanReusePausedInspection(discovery, selection, TimeSpan.FromTicks(-1)));
    Require(!WindowsProductBackend.CanReusePausedInspection(discovery with { SourcePaused = false }, selection, TimeSpan.Zero));
    Require(WindowsProductBackend.CanReusePausedInspection(discovery with { SourcePaused = false, RequiresNativePauseObservation = false }, selection, TimeSpan.Zero));
    Require(!WindowsProductBackend.CanReusePausedInspection(discovery, selection with { RenderDeviceId = "other" }, TimeSpan.Zero));
    Require(!WindowsProductBackend.CanReusePausedInspection(null, selection, TimeSpan.Zero));
});
Test("inactive retained session identifies signed bound audio process", () => Require(WindowsProductBackend.SelectAudioProcess([Observation(process, Session(process)), Observation(other)]) == process));
Test("cold no-session candidates cannot select by name", () => Block("EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN", () => WindowsProductBackend.SelectAudioProcess([Observation(process), Observation(other)])));
Test("multiple inactive audio identities remain ambiguous", () => Block("SPOTIFY_AUDIO_PROCESS_AMBIGUOUS", () => WindowsProductBackend.SelectAudioProcess([Observation(process, Session(process)), Observation(other, Session(other))])));
Test("partial observation cannot become process discovery", () => Block("COMPLETE_SPOTIFY_DISCOVERY_REQUIRED", () => WindowsProductBackend.SelectAudioProcess([Observation(process, Session(process)) with { CompleteForProcess = false }])));
Test("wrong full process identity in a row blocks discovery", () => Block("COMPLETE_SPOTIFY_DISCOVERY_REQUIRED", () => WindowsProductBackend.SelectAudioProcess([Observation(process, Session(other))])));
Test("ordinary exact Base pair shares native owner", () => Require(WindowsProductBackend.RequirePair(new("capture", "render"), [Endpoint("render", 0), Endpoint("capture", 1)]).Eligible));
Test("different capture owner cannot be adopted", () => Block("EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH", () => WindowsProductBackend.RequirePair(new("other-capture", "render"), [Endpoint("render", 0), Endpoint("capture", 1), Endpoint("other-capture", 1, "other")])));
Test("ambiguous Base capture inventory blocks selection", () => Block("ORDINARY_BASE_SPEAKER_IDENTITY_UNPROVED", () => WindowsProductBackend.RequirePair(new("capture", "render"), [Endpoint("render", 0), Endpoint("capture", 1), Endpoint("capture2", 1)])));
Test("nonordinary Base render cannot be selected", () => Block("ORDINARY_BASE_SPEAKER_IDENTITY_UNPROVED", () => WindowsProductBackend.RequirePair(new("capture", "render"), [Endpoint("render", 0, form: 2), Endpoint("capture", 1)])));
var options = new ObservationOptions { QuietPeriod = TimeSpan.FromMilliseconds(1), MaximumSnapshotAge = TimeSpan.FromSeconds(1), PollInterval = TimeSpan.FromMilliseconds(1) };
RawAudioSession Raw(uint pid, string endpoint = "render", AudioSessionState state = AudioSessionState.Inactive, int system = 1, int hr = 0) => new("raw-" + pid, endpoint, state, pid, hr, system);
SessionObservation Scan(FakeFeed feed, int[]? candidates = null)
{
    using var observer = new ProductSessionObserver(feed, "render", options);
    if (candidates is not null) observer.BindAudioProcessSet(candidates);
    using var bound = new FakeBound(process);
    return observer.Observe(bound, TimeSpan.FromMilliseconds(100));
}
Test("coherent empty set is complete but not process selection", () => Require(Scan(new()).CompleteForProcess));
Test("other active Base writer invalidates complete result", () => Require(!Scan(new(Raw(101), Raw(900, state: AudioSessionState.Active))).CompleteForProcess));
Test("other inactive Base row is not an active writer", () => Require(Scan(new(Raw(101), Raw(900))).CompleteForProcess));
Test("orphan selection allows surviving exact Spotify but excludes other live processes and completed journals", () => {
    var record = new RouteRecord(1, 1, Guid.NewGuid(), process, process,
        new BaseRenderEndpoint("base", "policy", "owner", "driver", true, true, true), RouteStage.HeldPaused,
        [new RouteRole(RenderRole.Console, null, RoleStage.Applied)], null, DateTimeOffset.UtcNow);
    Require(OrphanRouteRecovery.Eligible(record, process, false));
    Require(OrphanRouteRecovery.Eligible(record, process, true));
    Require(!OrphanRouteRecovery.Eligible(record, process with { Pid = process.Pid + 1 }, true));
    Require(!OrphanRouteRecovery.Eligible(record, process with { PolicyIdentity = "different" }, false));
    Require(!OrphanRouteRecovery.Eligible(record with { Stage = RouteStage.Restored }, process, false));
});
Test("active system sounds on Base cannot leak through the capture proof", () => Require(!Scan(new(Raw(101), Raw(0, state: AudioSessionState.Active, system: 0))).CompleteForProcess));
Test("inactive shared session is retained without becoming Spotify evidence", () => {
    var result = Scan(new(Raw(101), Raw(900, hr: RawAudioSession.NoSingleProcess)));
    Require(result.CompleteForProcess && result.Sessions.Length == 1);
});
Test("active ambiguous multiprocess row still blocks capture", () => Require(!Scan(new(Raw(101), Raw(900, state: AudioSessionState.Active, hr: RawAudioSession.NoSingleProcess))).CompleteForProcess));
Test("an incomplete endpoint never becomes complete product evidence", () => Require(!Scan(new(Raw(101)) { ThrowOnRead = true }).CompleteForProcess));
Test("a second candidate acquiring an inactive session blocks bound lifecycle", () => Require(!Scan(new(Raw(101), Raw(102, "physical")), [101, 102]).CompleteForProcess));
Test("refreshed helper set accepts no-audio child but rejects a new audio child", () =>
{
    var feed = new FakeFeed(Raw(101));
    using var observer = new ProductSessionObserver(feed, "render", options);
    using var bound = new FakeBound(process);
    observer.BindAudioProcessSet([101]);
    Require(observer.ForPause.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
    observer.BindAudioProcessSet([101, 102]);
    Require(observer.ForPause.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
    feed.ReplaceRows(Raw(101), Raw(102, "physical"));
    Require(!observer.ForPause.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
});
Test("unrelated physical endpoint owner does not select another Spotify", () => Require(Scan(new(Raw(101), Raw(900, "physical", AudioSessionState.Active)), [101, 102]).CompleteForProcess));
Test("writer creation during the product final fence invalidates earlier rows", () =>
{
    var feed = new FakeFeed(Raw(101));
    feed.OnFence = () => feed.ReplaceRows(Raw(101), Raw(900, state: AudioSessionState.Active));
    Require(!Scan(feed).CompleteForProcess);
});
Test("environment change during active proof cannot leave readiness complete", () =>
{
    var checks = 0;
    using var observer = new ProductSessionObserver(new FakeFeed(Raw(101, state: AudioSessionState.Active)), "render", options);
    observer.BindEnvironmentGuard(() => { if (++checks == 2) throw new RouteBlockedException("BASE_DEFAULT_CHANGED"); });
    using var bound = new FakeBound(process);
    Block("BASE_DEFAULT_CHANGED", () => observer.Observe(bound, TimeSpan.FromMilliseconds(100)));
});
Test("clean later snapshot cannot clear poisoned capture interval", () =>
{
    var feed = new FakeFeed(Raw(101));
    using var observer = new ProductSessionObserver(feed, "render", options);
    using var bound = new FakeBound(process);
    Require(observer.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
    observer.BeginIsolation(process); Require(observer.IntervalIsolated);
    feed.PoisonInterval();
    Require(observer.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess && !observer.IntervalIsolated);
    Block("CAPTURE_INTERVAL_ALREADY_ARMED", () => observer.BeginIsolation(process));
});
Test("known foreign contamination does not invent activity in paused owned source", () =>
{
    using var observer = new ProductSessionObserver(new FakeFeed(Raw(101), Raw(900, state: AudioSessionState.Active)), "render", options);
    using var bound = new FakeBound(process);
    Require(!observer.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
    var paused = observer.ForPause.Observe(bound, TimeSpan.FromMilliseconds(100));
    Require(paused.CompleteForProcess && !paused.Sessions.Any(row => row.Active));
    Block("FRESH_CAPTURE_INTERVAL_BASELINE_REQUIRED", () => observer.BeginIsolation(process));
});
Test("guard failure before setter prevents both nonnull and null policy mutations", () =>
{
    var resolver = new FakeResolver(process);
    var guarded = new WindowsProductBackend.GuardedResolver(resolver, (_, _) => throw new RouteBlockedException("SOURCE_NOT_PAUSED"), () => { });
    using var bound = guarded.OpenVerified(process);
    Block("SOURCE_NOT_PAUSED", () => bound.Set(RenderRole.Console, "route"));
    Block("SOURCE_NOT_PAUSED", () => bound.Set(RenderRole.Multimedia, null));
    Require(resolver.Sets.Count == 0);
});
Test("nullable restore remains exact through guarded resolver", () =>
{
    var resolver = new FakeResolver(process); var order = new List<string>();
    using var bound = new WindowsProductBackend.GuardedResolver(resolver, (_, _) => order.Add("before"), () => order.Add("after")).OpenVerified(process);
    bound.Set(RenderRole.Multimedia, null);
    Require(resolver.Sets.Single() == (RenderRole.Multimedia, (string?)null) && order.SequenceEqual(["before", "after"]));
});
Test("runtime compatibility is independent of hardware qualification and probes Windows read-only", () =>
{
    var admission = WindowsProductAdmission.Automatic;
    if (!OperatingSystem.IsWindows()) Require(!admission.Capabilities.CanOperate && !admission.Capabilities.ProductionQualified && admission.Capabilities.Blockers.Contains("WINDOWS_REQUIRED"));
    else if (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64)
    {
        var capability = admission.Capabilities;
        Console.WriteLine("WINDOWS_READ_ONLY " + System.Text.Json.JsonSerializer.Serialize(capability));
        if (!capability.RuntimeCompatible)
            try { Folia.RouteResearch.Native.AppRouteProbe.ReadOnly(); }
            catch (Exception e) { Console.WriteLine("PROBE_DIAGNOSTIC " + e.Message + " HRESULT=" + e.HResult.ToString("X8")); }
        Require(capability.RuntimeCompatible && capability.Supported && capability.CanOperate && !capability.ProductionQualified && !capability.TrialAuthorized);
        Require(capability.WindowsBuild > 0 && capability.RouteInterfaceId is not null);
    }
});
if (args.Contains("--live-spotify-readonly"))
Test("live Spotify persisted roles are readable through the automatically selected interface without writes", () =>
{
    using var audio = new AudioReadOnly();
    var candidates = System.Diagnostics.Process.GetProcessesByName("Spotify");
    try
    {
        var pids = candidates.Select(p => p.Id).ToArray();
        var sessionPids = audio.Sessions(true).Where(s => s.HasSingleProcessIdentity && s.IsSystemSounds == false
            && s.State != 2 && pids.Contains((int)s.ReportedProcessId)).Select(s => (int)s.ReportedProcessId).Distinct().ToArray();
        Require(sessionPids.Length == 1);
        using var identity = new SpotifyIdentity(sessionPids[0]);
        var resolver = new Folia.RouteResearch.Windows.Win11SpotifyPolicyResolver(identity.Check);
        using var bound = resolver.OpenVerified(identity.Identity);
        var roles = Enum.GetValues<RenderRole>().Select(bound.Get).ToArray();
        Require(roles.SequenceEqual(Enum.GetValues<RenderRole>().Select(bound.Get)));
        Console.WriteLine("LIVE_SPOTIFY_READ_ONLY " + System.Text.Json.JsonSerializer.Serialize(new {
            rolesRead = roles.Length, reads = 6, unchanged = true, setters = 0,
            roleKinds = roles.Select(v => v is null ? "default" : "explicit"), distribution = identity.Identity.Distribution }));
    }
    finally { foreach (var candidate in candidates) candidate.Dispose(); }
});
Test("HQPlayer exclusive default change preserves exact compensation eligibility", () =>
{
    string?[] frozen = ["xingcore", "xingcore", "xingcore", "capture", "capture", "capture"];
    string?[] current = ["lgtv", "lgtv", "xingcore", "capture", "capture", "capture"];
    ProductDefaultEndpoints.RequireSafeRenderDefaults(current, id => Endpoint(id, 0) with { BaseIdentity = new("unsupported") });
    Require(!ProductDefaultEndpoints.Unchanged(frozen, current));
    var policy = new FakeResolver(process);
    using var bound = new WindowsProductBackend.GuardedResolver(policy,
        (_, _) => ProductDefaultEndpoints.RequireSafeRenderDefaults(current, id => Endpoint(id, 0) with { BaseIdentity = new("unsupported") }), () => { }).OpenVerified(process);
    bound.Set(RenderRole.Console, null); bound.Set(RenderRole.Multimedia, null);
    Require(policy.Sets.SequenceEqual([(RenderRole.Console, (string?)null), (RenderRole.Multimedia, (string?)null)]));
});
Test("OS default moving to Base still blocks capture feedback path", () =>
{
    string?[] current = ["render", "render", "physical", "capture", "capture", "capture"];
    Block("BASE_OR_UNPROVEN_DEFAULT_FEEDBACK_GUARD", () => ProductDefaultEndpoints.RequireSafeRenderDefaults(current, id => Endpoint(id, 0)));
});
Test("absence of render defaults is preserved without a fabricated endpoint", () =>
{
    string?[] current = [null, null, "physical", "capture", "capture", "capture"];
    ProductDefaultEndpoints.RequireSafeRenderDefaults(current, _ => throw new Exception("Unexpected endpoint read"));
    Require(ProductDefaultEndpoints.Unchanged(current, current.ToArray()));
});
Test("Base default risk is reported separately from exact compensation", () =>
{
    string?[] frozen = ["physical", "physical", "physical", "capture", "capture", "capture"];
    string?[] current = ["render", "render", "physical", "capture", "capture", "capture"];
    var status = ProductDefaultEndpoints.Status(frozen, current, id => Endpoint(id, 0));
    Require(status.FeedbackRisk && !status.Unchanged && status.Current[0] == "render" && status.Frozen[0] == "physical");
});
Test("Base feedback guard blocks capture proof but allows independent paused-source proof", () =>
{
    using var observer = new ProductSessionObserver(new FakeFeed(Raw(101)), "render", options);
    observer.BindEnvironmentGuard(() => throw new RouteBlockedException("BASE_DEFAULT_FEEDBACK"), () => { });
    using var bound = new FakeBound(process);
    Block("BASE_DEFAULT_FEEDBACK", () => observer.Observe(bound, TimeSpan.FromMilliseconds(100)));
    Require(observer.ForPause.Observe(bound, TimeSpan.FromMilliseconds(100)).CompleteForProcess);
});
foreach (var conflict in new[] { false, true })
Test(conflict ? "external role write still prevents all compensation under Base default drift" : "paused owned null compensation survives Base default drift without changing defaults", () =>
{
    var values = new MutablePolicy(process); var journal = new MemoryJournal();
    var target = new BaseRenderEndpoint("render", "pin", "owner", "driver", true, true, true);
    var defaultNow = "physical";
    var guarded = new WindowsProductBackend.GuardedResolver(values, (_, value) =>
    {
        // This models the production split after main closed PCM and source
        // pause succeeded: only a NEW route requires the feedback guard.
        if (value == target.PolicyValue && defaultNow == "render") throw new RouteBlockedException("BASE_DEFAULT_FEEDBACK");
    }, () => { });
    using var observer = new ProductSessionObserver(new FakeFeed(Raw(101)), "render", options);
    var transaction = new OwnedRouteTransaction(guarded, new EndpointVerifier(target), observer, journal);
    Require(transaction.AcquirePaused(process, target).Stage == RouteStage.HeldPaused);
    defaultNow = "render";
    if (conflict) values.Values[RenderRole.Console] = "external-user-choice";
    var writes = values.Writes;
    var result = transaction.Restore();
    if (conflict) Require(result.Stage == RouteStage.Conflict && values.Writes == writes && values.Values[RenderRole.Console] == "external-user-choice");
    else Require(result.Stage == RouteStage.Restored && values.Values[RenderRole.Console] is null && values.Values[RenderRole.Multimedia] is null);
    Require(defaultNow == "render");
});
passed += OriginalPolicySafetyTests.Run();
passed += PhysicalOriginalEndpointProbeTests.Run();
passed += ProductJournalInitializationTests.Run();
Console.WriteLine($"PASS {passed} product composition tests; includes a read-only local Windows interface probe when running on Windows x64; no audio playback or policy writes.");

sealed class FakeFeed(params RawAudioSession[] rows) : IReadOnlySessionFeed, IReadOnlySessionIsolationFeed
{
    public bool ThrowOnRead;
    public Action? OnFence;
    private Action<SessionFeedEvent>? changed;
    private bool armed, intervalPoisoned;
    public bool IntervalIsolated => armed && !intervalPoisoned;
    public void BeginIsolation(string endpoint, uint owner, CancellationToken ct) { ct.ThrowIfCancellationRequested(); armed = true; }
    public void PoisonInterval() => intervalPoisoned = true;
    public bool IsPublicationQuiescent { get { var callback = OnFence; OnFence = null; callback?.Invoke(); return true; } }
    public void ReplaceRows(params RawAudioSession[] replacement) { rows = replacement; changed?.Invoke(new(SessionFeedEventKind.SessionChanged)); }
    public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed, CancellationToken ct) { this.changed = changed; return new Empty(); }
    public string[] EnumerateActiveRenderEndpoints(CancellationToken ct) => rows.Select(x => x.EndpointId).Append("render").Distinct().ToArray();
    public IEndpointSessionFeed OpenEndpoint(string id, Action<SessionFeedEvent> changed, CancellationToken ct) => new Endpoint(this, id);
    public void Dispose() { }
    private sealed class Endpoint(FakeFeed owner, string id) : IEndpointSessionFeed
    {
        public string EndpointId => id;
        public RawAudioSession[] ReadSessions(CancellationToken ct) => owner.ThrowOnRead ? throw new InvalidOperationException("mock failure") : rowsForOwner();
        private RawAudioSession[] rowsForOwner() => owner.GetRows(id);
        public void Dispose() { }
    }
    private RawAudioSession[] GetRows(string id) => rows.Where(x => x.EndpointId == id).ToArray();
    private sealed class Empty : IDisposable { public void Dispose() { } }
}
sealed class FakeBound(SpotifyProcess identity, Action<RenderRole, string?>? set = null) : IBoundSpotifyPolicy
{
    public SpotifyProcess Identity => identity;
    public SpotifyProcess CheckLiveIdentity() => identity;
    public string? Get(RenderRole role) => null;
    public void Set(RenderRole role, string? endpoint) => set?.Invoke(role, endpoint);
    public void Dispose() { }
}
sealed class FakeResolver(SpotifyProcess process) : IVerifiedSpotifyResolver
{
    public List<(RenderRole, string?)> Sets = [];
    public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected) => new FakeBound(process, (role, value) => Sets.Add((role, value)));
}
sealed class MutablePolicy(SpotifyProcess process) : IVerifiedSpotifyResolver
{
    public Dictionary<RenderRole, string?> Values = Enum.GetValues<RenderRole>().ToDictionary(role => role, _ => (string?)null);
    public int Writes;
    public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected) => new Bound(this, process);
    private sealed class Bound(MutablePolicy owner, SpotifyProcess process) : IBoundSpotifyPolicy
    {
        public SpotifyProcess Identity => process;
        public SpotifyProcess CheckLiveIdentity() => process;
        public string? Get(RenderRole role) => owner.Values[role];
        public void Set(RenderRole role, string? value) { owner.Writes++; owner.Values[role] = value; }
        public void Dispose() { }
    }
}
sealed class MemoryJournal : IDurableRouteJournal
{
    private RouteRecord? record;
    public RouteRecord? ReadLatest() => record;
    public void Append(RouteRecord value) => record = value;
}
sealed class EndpointVerifier(BaseRenderEndpoint target) : ISelectedEndpointVerifier
{
    public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected) => target;
}
