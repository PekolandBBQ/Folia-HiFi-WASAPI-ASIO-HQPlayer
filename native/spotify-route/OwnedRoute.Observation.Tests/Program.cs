using Folia.RouteObservation;
using Folia.RouteResearch;
using Folia.RouteObservation.Windows;

var passed = 0;
void Check(bool value, string why) { if (!value) throw new Exception(why); }
void Run(string name, Action test) { test(); passed++; Console.WriteLine("PASS " + name); }
var settings = new ObservationOptions { QuietPeriod = TimeSpan.FromMilliseconds(2),
    MaximumSnapshotAge = TimeSpan.FromMilliseconds(300), PollInterval = TimeSpan.FromMilliseconds(1) };
CoherentSessionObserver Observer(Feed feed, TimeProvider? clock = null) => new(feed, settings, clock);
SessionObservation Observe(CoherentSessionObserver observer, Bound? bound = null, int waitMs = 150) =>
    observer.Observe(bound ?? new(), TimeSpan.FromMilliseconds(waitMs));
RawAudioSession Row(string id = "spotify-1", string endpoint = "base", uint pid = 42,
    AudioSessionState state = AudioSessionState.Active, int hr = 0, int system = 1) =>
    new(id, endpoint, state, pid, hr, system);
Feed DefaultFeed() => new() { Rows = { ["base"] = [Row()] } };

Run("property notification expires snapshot without losing retained coverage", () =>
{
    var f = DefaultFeed(); f.Rows["speakers"] = [Row("output", "speakers", 80)];
    using var observer = Observer(f); var first = Observe(observer);
    var registrations = f.Registers; var opens = f.Trace.Count(item => item.StartsWith("open:"));
    f.Emit("speakers", SessionFeedEventKind.EndpointPropertyChanged);
    Check(!observer.IsCurrentPublication(first), "Property event reused old proof");
    var next = Observe(observer);
    Check(next.CompleteForProcess && f.Registers == registrations && f.Trace.Count(item => item.StartsWith("open:")) == opens,
        "Property notification discarded retained endpoint subscriptions");
    f.Rows.Remove("speakers");
    f.Emit("base", SessionFeedEventKind.EndpointPropertyChanged);
    Check(Observe(observer).CompleteForProcess && f.LiveEndpoints == 1, "Rescan missed changed endpoint inventory");
});

Run("all endpoint subscriptions precede any session read", () =>
{
    var f = DefaultFeed(); f.Rows["speakers"] = [Row("other", "speakers", 80)];
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 1, "No complete single-target proof");
    Check(f.Trace[0] == "register-topology" && f.Trace.IndexOf("open:speakers") < f.Trace.IndexOf("read:base"), "Registration barrier violated");
    Check(result.Sessions[0].Process == Bound.Process && result.Sessions[0].SessionInstanceId == "spotify-1", "Exact identity/instance lost");
});
Run("unrelated output disappearance rescans without dropping Base subscriptions", () =>
{
    var f = DefaultFeed(); f.Rows["dac"] = [];
    using var observer = Observer(f); var first = Observe(observer);
    f.Rows.Remove("dac"); f.Emit("dac", SessionFeedEventKind.EndpointInventoryChanged);
    Check(!observer.IsCurrentPublication(first), "Output event left stale publication valid");
    Check(Observe(observer).CompleteForProcess && f.Registers == 1 && f.LiveEndpoints == 1
        && f.Trace.Count(x => x == "open:base") == 1, "Output change discarded Base coverage");
});
Run("known non-target and proven system sessions do not block", () =>
{
    var f = DefaultFeed(); f.Rows["base"].Add(Row("other", pid: 71));
    f.Rows["base"].Add(Row("system", pid: 0, hr: RawAudioSession.NoSingleProcess, system: 0));
    using var observer = Observer(f); Check(Observe(observer).CompleteForProcess, "Proven unrelated row blocked");
});
Run("target inactive state is preserved and expired rows excluded", () =>
{
    var f = DefaultFeed(); f.Rows["base"] = [Row(state: AudioSessionState.Inactive), Row("expired", state: AudioSessionState.Expired, hr: -1)];
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 1 && !result.Sessions[0].Active, "State semantics lost");
});
Run("empty endpoint and target sets are coherent but never fabricate activity", () =>
{
    using var observer = Observer(new()); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 0, "Empty coherent inventory misreported");
});
Run("inactive cross-process session does not block Spotify and becoming active invalidates discovery", () =>
{
    var f = DefaultFeed();
    f.Rows["speakers"] = [Row("peek", "speakers", 81, AudioSessionState.Inactive, RawAudioSession.NoSingleProcess)];
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 1, "Inactive unrelated shared session blocked Spotify");
    f.Rows["speakers"][0] = f.Rows["speakers"][0] with { State = AudioSessionState.Active };
    f.Emit("speakers", SessionFeedEventKind.SessionChanged);
    Check(!observer.IsCurrentPublication(result), "Shared session activation kept old proof");
    Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Active ambiguous session was ignored");
});
foreach (var row in new[] { Row(hr: RawAudioSession.NoSingleProcess), Row(pid: 81, hr: RawAudioSession.NoSingleProcess),
    Row(hr: -1), Row(pid: 0), Row(pid: uint.MaxValue), Row(system: -1), Row(system: 2) })
Run("ambiguous row blocked: " + row, () =>
{
    var f = DefaultFeed(); f.Rows["base"].Add(row with { SessionInstanceId = "unknown" });
    using var observer = Observer(f); Check(!Observe(observer, waitMs: 15).CompleteForProcess, "Unknown ownership certified");
});
Run("endpoint read failure cannot shrink complete endpoint coverage", () =>
{
    var f = DefaultFeed(); f.Rows["speakers"] = []; f.FailEndpoint = "speakers";
    using var observer = Observer(f); Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Partial endpoint inventory certified");
});
Run("session creation racing enumeration is included after retry", () =>
{
    var f = DefaultFeed(); f.OnRead = (id, n) => { if (n == 1) { f.Rows[id].Add(Row("created")); f.Emit(id); } };
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 2 && f.Reads >= 3, "Creation race certified stale rows");
});
Run("lost event poisons generation and forces new registration", () =>
{
    var f = DefaultFeed(); f.OnRead = (_, n) => { if (n == 1) f.Emit("base", SessionFeedEventKind.EventLoss); };
    using var observer = Observer(f); Check(Observe(observer).CompleteForProcess && f.Registers >= 2 && observer.Generation >= 2, "Event loss reused incomplete generation");
});
Run("persistent event loss stays incomplete within deadline", () =>
{
    var f = DefaultFeed(); f.OnRead = (_, _) => f.Emit("base", SessionFeedEventKind.EventLoss);
    using var observer = Observer(f); Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Continuous losses certified");
});
Run("endpoint hotplug without callback is detected by inventories", () =>
{
    var f = DefaultFeed(); f.OnRead = (_, n) => { if (n == 1) f.Rows["new"] = [Row("new-session", "new")]; };
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Any(s => s.EndpointId == "new") && f.Registers == 1,
        "Inventory rescan omitted new endpoint or dropped retained subscriptions");
});
Run("endpoint disconnect during read forces recovery before proof", () =>
{
    var f = DefaultFeed(); f.Rows["speakers"] = [Row("other", "speakers", 55)];
    f.OnRead = (_, n) => { if (n == 1) { f.Rows.Remove("speakers"); f.Emit("base", SessionFeedEventKind.EndpointTopologyChanged); } };
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 1 && f.Registers >= 2, "Disconnect failed generation recovery");
});
Run("destroyed session is removed before coherent snapshot", () =>
{
    var f = DefaultFeed(); f.OnRead = (id, n) => { if (n == 1) { f.Rows[id].Clear(); f.Emit(id); } };
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && result.Sessions.Length == 0 && f.Reads >= 3, "Destroyed session leaked");
});
Run("silent row state change is rejected by second full read", () =>
{
    var f = DefaultFeed(); f.OnRead = (id, n) => { if (n == 1) f.Rows[id][0] = Row(state: AudioSessionState.Inactive); };
    using var observer = Observer(f); var result = Observe(observer);
    Check(result.CompleteForProcess && !result.Sessions[0].Active && f.Reads >= 4
        && f.Registers == 1 && f.Trace.Count(x => x == "open:base") == 1,
        "Stale first read certified or retained capture coverage discarded");
});
Run("old disposed callbacks do not contaminate a new generation", () =>
{
    var f = DefaultFeed(); using var observer = Observer(f); Check(Observe(observer).CompleteForProcess, "Initial failed");
    var old = f.EndpointCallbacks["base"];
    f.Emit("base", SessionFeedEventKind.EventLoss); Check(Observe(observer).CompleteForProcess, "Recovery failed");
    var generation = observer.Generation; old(new(SessionFeedEventKind.EventLoss, "base"));
    Check(Observe(observer).CompleteForProcess && observer.Generation == generation, "Stale generation callback accepted");
});
Run("changed process start generation is rejected", () =>
{
    var f = DefaultFeed(); var bound = new Bound(); f.OnRead = (_, n) => { if (n == 1) bound.Live = Bound.Process with { StartTimeUtcTicks = Bound.Process.StartTimeUtcTicks + 1 }; };
    using var observer = Observer(f);
    try { Observe(observer, bound); throw new Exception("PID reuse certified"); }
    catch (RouteBlockedException e) { Check(e.Message == "SESSION_PROCESS_GENERATION_CHANGED", "Wrong failure"); }
});
Run("changed image identity is rejected even at same PID/start", () =>
{
    var f = DefaultFeed(); var bound = new Bound(); f.OnRead = (_, n) => { if (n == 1) bound.Live = Bound.Process with { ImageIdentity = "different" }; };
    using var observer = Observer(f);
    try { Observe(observer, bound); throw new Exception("Image substitution certified"); } catch (RouteBlockedException) { }
});
Run("caller cancellation is honored and later observation re-registers", () =>
{
    var f = DefaultFeed(); using var cancel = new CancellationTokenSource();
    f.OnRead = (_, n) => { if (n == 1) cancel.Cancel(); };
    using var observer = Observer(f);
    try { observer.Observe(new Bound(), TimeSpan.FromMilliseconds(100), cancel.Token); throw new Exception("Cancellation ignored"); }
    catch (OperationCanceledException) { }
    Check(Observe(observer).CompleteForProcess && f.Registers >= 2, "Canceled generation reused");
});
Run("duplicate instance rows cannot silently collapse", () =>
{
    var f = DefaultFeed(); f.Rows["base"].Add(Row()); using var observer = Observer(f);
    Check(!Observe(observer, waitMs: 15).CompleteForProcess, "Duplicate row accepted");
});
Run("endpoint mismatch fails proof", () =>
{
    var f = DefaultFeed(); f.Rows["base"][0] = Row(endpoint: "wrong"); using var observer = Observer(f);
    Check(!Observe(observer, waitMs: 15).CompleteForProcess, "Wrong endpoint accepted");
});
Run("snapshot maximum age is enforced using monotonic clock", () =>
{
    var f = DefaultFeed(); var clock = new FastClock(); using var observer = Observer(f, clock);
    Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Stale snapshot certified");
});
Run("continuous change is bounded and never certified", () =>
{
    var f = DefaultFeed(); f.OnRead = (id, _) => f.Emit(id); using var observer = Observer(f);
    var started = System.Diagnostics.Stopwatch.StartNew(); Check(!Observe(observer, waitMs: 20).CompleteForProcess && started.Elapsed < TimeSpan.FromSeconds(2), "Unbounded or falsely stable");
});
Run("event during final timestamp cannot certify a newer stale proof", () =>
{
    var f = DefaultFeed(); var clock = new CallbackClock(() => f.Emit("base"));
    using var observer = Observer(f, clock);
    Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Timestamp event passed final revision fence");
});
Run("observer disposal releases all registration lifetimes", () =>
{
    var f = DefaultFeed(); var observer = Observer(f); Observe(observer); observer.Dispose(); observer.Dispose();
    Check(f.LiveEndpoints == 0 && f.LiveTopology == 0 && f.Disposed, "Notification lifetime leaked");
});
Run("held callback cannot hide a notification-only created session", () =>
{
    var f = DefaultFeed(); using var observer = Observer(f);
    Check(Observe(observer).CompleteForProcess, "Initial proof failed");
    var queue = new CallbackPublicationQueue<RawAudioSession>(4);
    f.Publications = queue; using var enteredRead = new ManualResetEventSlim(); f.ReadFenceEntered = enteredRead;
    Check(queue.TryEnter(), "Callback entry failed"); f.Emit("base");
    var pending = Task.Run(() => Observe(observer, waitMs: 1000));
    try
    {
        Check(enteredRead.Wait(TimeSpan.FromSeconds(1)), "Read never reached publication fence");
        Check(!pending.Wait(TimeSpan.FromMilliseconds(15)), "Read completed while callback pointer was unpublished");
        Check(queue.TryPublish(Row("notification-only")), "Publication failed"); f.Emit("base");
    }
    finally { queue.Exit(); }
    var result = pending.GetAwaiter().GetResult();
    Check(result.CompleteForProcess && result.Sessions.Any(x => x.SessionInstanceId == "notification-only"), "Notification-only session omitted");
});
Run("callback publication queue refuses overflow without losing retained entries", () =>
{
    var queue = new CallbackPublicationQueue<int>(1); Check(queue.TryEnter(), "Entry failed");
    try { Check(queue.TryPublish(17) && !queue.TryPublish(23), "Capacity was not enforced"); }
    finally { queue.Exit(); }
    Check(queue.IsIdle && queue.PendingCount == 1 && queue.TryTake(out var value) && value == 17 && queue.PendingCount == 0, "Overflow corrupted ownership");
});
Run("callback entering after last native read cannot pass final publication fence", () =>
{
    var f = DefaultFeed(); var queue = new CallbackPublicationQueue<RawAudioSession>(1); f.Publications = queue;
    var entered = false; var clock = new CallbackClock(() => { if (!entered) { entered = queue.TryEnter(); } });
    using var observer = Observer(f, clock);
    try { Check(!Observe(observer, waitMs: 20).CompleteForProcess, "Unpublished final callback certified"); }
    finally { if (entered) queue.Exit(); }
});
Run("close rejects late callback entry but retains already-entered publication", () =>
{
    var queue = new CallbackPublicationQueue<int>(2); Check(queue.TryEnter(), "Entry failed"); queue.Close();
    Check(!queue.IsIdle && !queue.TryEnter() && queue.TryPublish(91), "Close lost existing callback or admitted new callback");
    queue.Exit(); Check(queue.IsIdle && queue.TryTake(out var value) && value == 91, "Late publication stranded after close");
});
Run("stuck callback publication wait has a real bounded timeout", () =>
{
    var queue = new CallbackPublicationQueue<int>(1); Check(queue.TryEnter(), "Entry failed");
    var stopwatch = System.Diagnostics.Stopwatch.StartNew();
    try { queue.WaitUntilIdle(TimeSpan.FromMilliseconds(10), () => { }); throw new Exception("Stuck callback passed fence"); }
    catch (TimeoutException) { Check(stopwatch.Elapsed < TimeSpan.FromSeconds(1), "Publication wait was not bounded"); }
    finally { queue.Exit(); }
});
Run("cancellation interrupts publication wait before publishing proof", () =>
{
    var queue = new CallbackPublicationQueue<int>(1); Check(queue.TryEnter(), "Entry failed");
    using var cancel = new CancellationTokenSource(); cancel.Cancel();
    try { queue.WaitUntilIdle(TimeSpan.FromSeconds(1), cancel.Token.ThrowIfCancellationRequested); throw new Exception("Canceled fence passed"); }
    catch (OperationCanceledException) { }
    finally { queue.Exit(); }
});
Run("parallel callback publications retain every accepted item exactly once", () =>
{
    var queue = new CallbackPublicationQueue<int>(2048);
    Parallel.For(0, 1000, i => { if (!queue.TryEnter()) throw new Exception("Queue closed unexpectedly");
        try { if (!queue.TryPublish(i)) throw new Exception("Unexpected overflow"); } finally { queue.Exit(); } });
    queue.WaitUntilIdle(TimeSpan.FromSeconds(1), () => { }); var items = new HashSet<int>();
    while (queue.TryTake(out var item)) Check(items.Add(item), "Duplicate publication");
    Check(items.Count == 1000 && queue.PendingCount == 0 && queue.IsIdle, "Concurrent publication lost ownership");
});
Run("default-only change refreshes proof without losing retained subscriptions", () =>
{
    var feed = DefaultFeed();
    feed.OnRead = (id, count) => { if (count == 1) feed.Emit(id, SessionFeedEventKind.DefaultChanged); };
    using var observer = Observer(feed);
    Check(Observe(observer).CompleteForProcess && feed.Registers == 1, "Benign default change discarded coverage");
});
passed += IntervalTests.Run();
Console.WriteLine($"{passed} observation tests passed; no Windows/COM execution.");

sealed class Bound : IBoundSpotifyPolicy
{
    public static SpotifyProcess Process = new(42, 638900000000000000, "S-1-5-test", "Spotify.Policy", "verified:image", "desktop");
    public SpotifyProcess Identity => Process;
    public SpotifyProcess Live = Process;
    public SpotifyProcess CheckLiveIdentity() => Live;
    public string? Get(RenderRole role) => throw new Exception("Observer read policy");
    public void Set(RenderRole role, string? endpoint) => throw new Exception("Observer called setter");
    public void Dispose() { }
}
sealed class Feed : IReadOnlySessionFeed
{
    public Dictionary<string, List<RawAudioSession>> Rows = new(StringComparer.Ordinal);
    public Dictionary<string, Action<SessionFeedEvent>> EndpointCallbacks = new(StringComparer.Ordinal);
    public List<string> Trace = [];
    public Action<string, int>? OnRead;
    public string? FailEndpoint;
    public int Reads, Registers, LiveEndpoints, LiveTopology;
    public bool Disposed;
    public CallbackPublicationQueue<RawAudioSession>? Publications;
    public ManualResetEventSlim? ReadFenceEntered;
    public bool IsPublicationQuiescent => !Disposed &&
        (Publications == null || (Publications.IsIdle && Publications.PendingCount == 0));
    public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed, CancellationToken ct)
    { ct.ThrowIfCancellationRequested(); Trace.Add("register-topology"); Registers++; LiveTopology++; return new Cleanup(() => LiveTopology--); }
    public string[] EnumerateActiveRenderEndpoints(CancellationToken ct)
    { ct.ThrowIfCancellationRequested(); Trace.Add("inventory"); return Rows.Keys.ToArray(); }
    public IEndpointSessionFeed OpenEndpoint(string id, Action<SessionFeedEvent> changed, CancellationToken ct)
    { ct.ThrowIfCancellationRequested(); Trace.Add("open:" + id); EndpointCallbacks[id] = changed; LiveEndpoints++; return new Endpoint(this, id); }
    public void Emit(string id, SessionFeedEventKind kind = SessionFeedEventKind.SessionChanged) => EndpointCallbacks[id](new(kind, id));
    public void Dispose() => Disposed = true;
    private sealed class Endpoint(Feed feed, string id) : IEndpointSessionFeed
    {
        public string EndpointId => id;
        private bool disposed;
        public RawAudioSession[] ReadSessions(CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested(); feed.Trace.Add("read:" + id);
            if (feed.FailEndpoint == id) throw new IOException("Endpoint unavailable");
            if (feed.Publications is { } queue)
            {
                feed.ReadFenceEntered?.Set();
                queue.WaitUntilIdle(TimeSpan.FromSeconds(1), ct.ThrowIfCancellationRequested);
                while (queue.TryTake(out var published)) feed.Rows[published.EndpointId].Add(published);
            }
            // Read first so OnRead can model a callback racing the return.
            var rows = feed.Rows[id].ToArray(); feed.OnRead?.Invoke(id, ++feed.Reads); return rows;
        }
        public void Dispose() { if (!disposed) { disposed = true; feed.LiveEndpoints--; } }
    }
    private sealed class Cleanup(Action dispose) : IDisposable
    { private bool done; public void Dispose() { if (!done) { done = true; dispose(); } } }
}
sealed class FastClock : TimeProvider
{
    private long ticks;
    public override long TimestampFrequency => 1000;
    public override long GetTimestamp() => Interlocked.Add(ref ticks, 1000);
}
sealed class CallbackClock(Action callback) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() { callback(); return DateTimeOffset.UtcNow; }
}
