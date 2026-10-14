using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Folia.RouteResearch;
using Folia.RouteResearch.Native;
using System.Runtime.InteropServices;

// Independent transaction tests. All process, endpoint, policy and session evidence
// below is simulated. The abrupt child-process cases exercise real journal files.
if (args.Length > 0 && args[0] == "crash-child")
{
    var directory = args[1];
    var setNumber = int.Parse(args[2]);
    var restoring = args[3] == "restore";
    var platform = new FakePlatform { PolicyPath = Path.Combine(directory, "policy.json") };
    using var journal = new FileRouteJournal(Path.Combine(directory, "route.journal"));
    var controller = platform.Controller(journal);
    if (restoring)
    {
        controller.Begin(platform.Live, platform.Endpoint);
        platform.CrashOnSet = platform.Writes.Count + setNumber;
        controller.Restore();
    }
    else
    {
        platform.CrashOnSet = setNumber;
        controller.Begin(platform.Live, platform.Endpoint);
    }
    throw new Exception("Expected abrupt child exit did not occur");
}

var passed = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
void Run(string name, Action action) { action(); passed++; Console.WriteLine("PASS " + name); }
void Throws<T>(Action action) where T : Exception
{
    try { action(); } catch (T) { return; }
    throw new Exception("Expected " + typeof(T).Name);
}
void Restored(FakePlatform p) => Check(p.Values.SequenceEqual(p.Originals), "Original null/custom/empty values were not restored exactly");

Run("supervisor cancellation before apply performs zero writes", () =>
{
    var p=new FakePlatform(); var j=new MemoryJournal();
    var c=new OwnedRouteTransaction(p,p,p,j,cancelRequested:()=>true);
    Throws<OperationCanceledException>(()=>c.Begin(p.Live,p.Endpoint));
    Check(p.Writes.Count==0 && j.Current is null,"Cancelled request mutated policy");
});
Run("supervisor cancellation between role writes restores the owned first role", () =>
{
    var p=new FakePlatform(); var j=new MemoryJournal(); var cancelled=false;
    p.BeforeSet=(_,_)=>cancelled=true;
    var c=new OwnedRouteTransaction(p,p,p,j,cancelRequested:()=>cancelled);
    Check(c.Begin(p.Live,p.Endpoint).Stage==RouteStage.RolledBack,"Cancelled partial apply not rolled back");
    Check(p.Writes.Count==2 && p.Writes.All(x=>x.Role==RenderRole.Console),"Cancellation affected extra role"); Restored(p);
});

Run("all originals are durably prepared before any role write; exact values restored", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal(); var c = p.Controller(j);
    p.BeforeSet = (_, _) => Check(j.Current is not null && j.Current.Roles.Length == 3 &&
        j.Current.Roles.Select(x => x.Original).SequenceEqual(p.Originals), "Incomplete backup at setter");
    Check(c.Begin(p.Live, p.Endpoint).Stage == RouteStage.Active, "No active proof");
    Check(p.ObserverCalls == 1 && p.ObservationBudget == TimeSpan.FromSeconds(5), "Unbounded/repeated observation");
    Check(c.Restore().Stage == RouteStage.Restored, "Restore not complete"); Restored(p);
    Check(p.Writes.Count == 4 && p.Writes.All(x => x.Role != RenderRole.Communications), "Wrong role scope");
});

foreach (var role in Enum.GetValues<RenderRole>())
    Run("getter failure during full backup issues zero writes: " + role, () =>
    {
        var p = new FakePlatform { GetFailure = role }; var j = new MemoryJournal();
        Throws<IOException>(() => p.Controller(j).Begin(p.Live, p.Endpoint));
        Check(p.Writes.Count == 0 && j.Current is null, "Failed getter was treated as default or partial backup used");
    });

Run("failed Prepared durable commit forbids every setter", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal { FailWhen = x => x.Stage == RouteStage.Prepared };
    Throws<JournalUnavailableException>(() => p.Controller(j).Begin(p.Live, p.Endpoint));
    Check(p.Writes.Count == 0, "Write before durable prepared record");
});

Run("journal failure after OS write preserves intent and stops further writes", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal { FailWhen = x => x.Roles.Any(r => r.Stage == RoleStage.Applied) };
    var c = p.Controller(j);
    Throws<JournalUnavailableException>(() => c.Begin(p.Live, p.Endpoint));
    Check(p.Writes.Count == 1 && j.Current!.Roles[0].Stage == RoleStage.ApplyIntent, "Uncertain native result lost");
    j.FailWhen = null;
    Check(p.Controller(j).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Recovery failed"); Restored(p);
});

Run("uncertain journal acknowledgement before setter does not authorize a write", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal();
    j.AfterAppend = r => { if (r.Roles.Any(x => x.Stage == RoleStage.ApplyIntent)) throw new IOException("Committed but acknowledgement failed"); };
    Throws<JournalUnavailableException>(() => p.Controller(j).Begin(p.Live, p.Endpoint));
    Check(p.Writes.Count == 0 && j.Current!.Roles[0].Stage == RoleStage.ApplyIntent, "Unacknowledged intent authorized mutation");
    j.AfterAppend = null;
    Check(p.Controller(j).RecoverAndRestore(p.Live).Stage == RouteStage.Restored && p.Writes.Count == 0, "Unapplied intent caused needless restore write"); Restored(p);
});

Run("getter failure after successful setter retains backup without guessing default", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal();
    p.BeforeSet = (role, _) => p.GetFailure = role;
    Check(p.Controller(j).Begin(p.Live, p.Endpoint).Stage == RouteStage.RecoveryRequired, "Failed readback claimed success");
    Check(p.Writes.Count == 1 && p.Values[0] == p.Endpoint.PolicyValue, "Readback failure triggered guessed overwrite");
    p.BeforeSet = null; p.GetFailure = null;
    Check(p.Controller(j).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Failed-readback recovery failed"); Restored(p);
});

foreach (var failAfterWrite in new[] { false, true })
    Run("second setter failure rolls back partial apply; wrote before throw=" + failAfterWrite, () =>
    {
        var p = new FakePlatform { FailSetCall = 2, FailAfterWrite = failAfterWrite };
        var result = p.Controller(new MemoryJournal()).Begin(p.Live, p.Endpoint);
        Check(result.Stage == RouteStage.RolledBack, "Partial route did not roll back"); Restored(p);
    });

foreach (var observation in new[] { "no-active", "wrong-endpoint", "incomplete", "stale", "wrong-process", "mixed", "blank-session" })
    Run("policy success alone cannot validate session: " + observation, () =>
    {
        var p = new FakePlatform { ObservationMode = observation };
        var result = p.Controller(new MemoryJournal()).Begin(p.Live, p.Endpoint);
        Check(result.Stage == RouteStage.RolledBack, "Unproved session became Active"); Restored(p);
    });

Run("preexisting target is never owned or reset", () =>
{
    var p = new FakePlatform(); p.Values[1] = p.Endpoint.PolicyValue; p.Originals[1] = p.Endpoint.PolicyValue;
    var c = p.Controller(new MemoryJournal());
    Check(c.Begin(p.Live, p.Endpoint).Roles[1].Stage == RoleStage.PreexistingTarget, "Preexisting ownership claimed");
    c.Restore(); Restored(p);
    Check(p.Writes.All(x => x.Role != RenderRole.Multimedia), "Unowned role changed");
});

Run("core preserves an opaque empty original without silently normalizing it", () =>
{
    var p = new FakePlatform(); p.Values[0] = ""; p.Originals[0] = "";
    var c = p.Controller(new MemoryJournal()); c.Begin(p.Live, p.Endpoint); c.Restore(); Restored(p);
});

Run("communications is backup-only even when another owner changes it", () =>
{
    var p = new FakePlatform(); var c = p.Controller(new MemoryJournal()); c.Begin(p.Live, p.Endpoint);
    p.Values[2] = "new-communications-choice";
    Check(c.Restore().Stage == RouteStage.Restored, "Unowned role prevented owned cleanup");
    Check(p.Values[2] == "new-communications-choice" && p.Writes.All(x => x.Role != RenderRole.Communications), "Unowned communications preference was touched");
});

Run("all preexisting target roles remain unowned and never get reset to invented defaults", () =>
{
    var p = new FakePlatform();
    p.Values[0] = p.Values[1] = p.Originals[0] = p.Originals[1] = p.Endpoint.PolicyValue;
    var c = p.Controller(new MemoryJournal());
    Check(c.Begin(p.Live, p.Endpoint).Stage == RouteStage.Active, "Preexisting proven route rejected");
    Check(c.Restore().Stage == RouteStage.Restored && p.Writes.Count == 0, "Preexisting route was claimed/reset"); Restored(p);
});

Run("external change before a role apply stops without overwriting it", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal();
    j.AfterAppend = x => { if (x.Stage == RouteStage.Prepared) p.Values[1] = "user-selected"; };
    var result = p.Controller(j).Begin(p.Live, p.Endpoint);
    Check(result.Stage == RouteStage.Conflict && p.Writes.Count == 1 && p.Values[1] == "user-selected", "User route overwritten");
});

Run("restore preflights all roles and stops all writes on external conflict", () =>
{
    var p = new FakePlatform(); var c = p.Controller(new MemoryJournal()); c.Begin(p.Live, p.Endpoint);
    p.Values[0] = "user-selected"; var before = p.Writes.Count;
    Check(c.Restore().Stage == RouteStage.Conflict && p.Writes.Count == before, "Restore overwrote conflict");
    Check(p.Values[0] == "user-selected", "User value lost");
});

Run("active lifecycle detects external changes with no reapply", () =>
{
    var p = new FakePlatform(); var c = p.Controller(new MemoryJournal()); c.Begin(p.Live, p.Endpoint);
    p.Values[1] = "user-selected"; var before = p.Writes.Count;
    Check(c.ValidateActive().Stage == RouteStage.Conflict && p.Writes.Count == before, "Reapply fought user change");
});

Run("reused PID requires fresh full identity; wrong application recovery is refused", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal(); var c = p.Controller(j); c.Begin(p.Live, p.Endpoint);
    var old = p.Live; p.Live = old with { StartTimeUtcTicks = old.StartTimeUtcTicks + 100, PolicyIdentity = "other-app" };
    Check(c.Restore().Stage == RouteStage.ReidentityRequired, "Same PID trusted after restart");
    Throws<RouteBlockedException>(() => c.RecoverAndRestore(p.Live));
    Check(p.Writes.Count == 2, "Wrong application was changed");
});

Run("verified same application can recover across PID and start-time change", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal(); var c = p.Controller(j); c.Begin(p.Live, p.Endpoint);
    p.Live = p.Live with { Pid = 9090, StartTimeUtcTicks = p.Live.StartTimeUtcTicks + 200 };
    Check(c.Restore().Stage == RouteStage.ReidentityRequired, "Restart was not detected");
    Check(p.Controller(j).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Verified app reidentity failed");
    Restored(p);
});

foreach (var mutate in new Func<BaseRenderEndpoint, BaseRenderEndpoint>[] {
    x => x with { TrustedBase = false }, x => x with { OrdinaryRender = false },
    x => x with { Active = false }, x => x with { PnpOwnerIdentity = "" } })
    Run("untrusted/nonordinary/inactive endpoint cannot be applied", () =>
    {
        var p = new FakePlatform(); p.Endpoint = mutate(p.Endpoint);
        Throws<RouteBlockedException>(() => p.Controller(new MemoryJournal()).Begin(p.Live, p.Endpoint));
        Check(p.Writes.Count == 0, "Unverified endpoint accepted");
    });

Run("selected endpoint identity must match fresh verified inventory", () =>
{
    var p = new FakePlatform(); var selected = p.Endpoint with { Id = "same-friendly-name-other-device" };
    Throws<RouteBlockedException>(() => p.Controller(new MemoryJournal()).Begin(p.Live, selected));
    Check(p.Writes.Count == 0, "Fresh endpoint mismatch ignored");
});

Run("incomplete process identity cannot cause a policy write", () =>
{
    var p = new FakePlatform();
    Throws<RouteBlockedException>(() => p.Controller(new MemoryJournal()).Begin(p.Live with { PolicyIdentity = "" }, p.Endpoint));
    Check(p.Writes.Count == 0, "PID-only target accepted");
});

Run("second open transaction is blocked", () =>
{
    var p = new FakePlatform(); var c = p.Controller(new MemoryJournal()); c.Begin(p.Live, p.Endpoint);
    Throws<RouteBlockedException>(() => c.Begin(p.Live, p.Endpoint));
    Check(p.Writes.Count == 2, "Original overwritten by target snapshot");
});

Run("restore setter error leaves durable recovery state and resumes safely", () =>
{
    var p = new FakePlatform(); var j = new MemoryJournal(); var c = p.Controller(j); c.Begin(p.Live, p.Endpoint);
    p.FailSetCall = 3; p.FailAfterWrite = true;
    Check(c.Restore().Stage == RouteStage.RecoveryRequired, "Failed restore claimed complete");
    Check(p.Controller(j).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Restore did not resume"); Restored(p);
});

foreach (var mode in new[] { "apply", "restore" })
    foreach (var roleNumber in new[] { 1, 2 })
        Run($"abrupt helper death after {mode} role {roleNumber}; file journal recovery", () =>
        {
            var directory = Path.Combine(Path.GetTempPath(), "folia-owned-route-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false };
                if (Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "dotnet")
                    start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
                foreach (var arg in new[] { "crash-child", directory, roleNumber.ToString(), mode }) start.ArgumentList.Add(arg);
                using var child = Process.Start(start)!;
                Check(child.WaitForExit(10_000), "Crash simulation hung");
                Check(child.ExitCode == 91, "Unexpected child exit " + child.ExitCode);
                var p = new FakePlatform { PolicyPath = Path.Combine(directory, "policy.json") };
                p.LoadPolicy();
                Check(!p.Values.SequenceEqual(p.Originals) || (mode == "restore" && roleNumber == 2), "Helper death auto-restored persistent policy unexpectedly");
                using var journal = new FileRouteJournal(Path.Combine(directory, "route.journal"));
                Check(journal.ReadLatest() is not null, "Durable Prepared lost");
                Check(p.Controller(journal).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Crash recovery failed"); Restored(p);
            }
            finally { Directory.Delete(directory, recursive: true); }
        });

Run("journal rejects concurrent owners, ignores torn suffix, rejects complete corruption", () =>
{
    var directory = Path.Combine(Path.GetTempPath(), "folia-owned-route-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
    var path = Path.Combine(directory, "journal");
    try
    {
        var p = new FakePlatform();
        using (var journal = new FileRouteJournal(path))
        {
            p.Controller(journal).Begin(p.Live, p.Endpoint);
            Throws<IOException>(() => { using var rejected = new FileRouteJournal(path); });
        }
        var committedSize = new FileInfo(path).Length;
        File.AppendAllText(path, "{\"incomplete\":");
        using (var reopened = new FileRouteJournal(path))
        {
            Check(new FileInfo(path).Length == committedSize, "Torn suffix not isolated");
            Check(p.Controller(reopened).RecoverAndRestore(p.Live).Stage == RouteStage.Restored, "Torn tail hid committed intent");
        }
        File.AppendAllText(path, "{\"corrupt\":true}\n");
        Throws<JournalUnavailableException>(() => { using var rejected = new FileRouteJournal(path); });
    }
    finally { Directory.Delete(directory, recursive: true); }
});

Run("journal create-new/open-existing modes never overwrite or fabricate backups", () =>
{
    var path=Path.Combine(Path.GetTempPath(),"folia-journal-open-"+Guid.NewGuid()+".jsonl");
    try
    {
        Throws<FileNotFoundException>(()=>{ using var j=new FileRouteJournal(path,mustExist:true); });
        Check(!File.Exists(path),"Restore created missing journal");
        using(var first=new FileRouteJournal(path,createNew:true)) { }
        Throws<IOException>(()=>{ using var j=new FileRouteJournal(path,createNew:true); });
        Check(new FileInfo(path).Length==0,"Create-new modified existing journal");
    }
    finally { File.Delete(path); }
});
Run("journal validates held file before append and truncation", () =>
{
    var path=Path.Combine(Path.GetTempPath(),"folia-journal-guard-"+Guid.NewGuid()+".jsonl"); var calls=0;
    try
    {
        using(var journal=new FileRouteJournal(path,createNew:true,validateHandle:_=>calls++))
        { var p=new FakePlatform(); p.Controller(journal).Begin(p.Live,p.Endpoint); Check(calls>4,"No per-append identity checks"); }
        File.AppendAllText(path,"torn");
        var size=new FileInfo(path).Length;
        Throws<JournalUnavailableException>(()=>{ using var j=new FileRouteJournal(path,mustExist:true,validateHandle:_=>throw new IOException("unsafe")); });
        Check(new FileInfo(path).Length==size,"Guard failure truncated evidence");
    }
    finally { File.Delete(path); }
});

Run("native ABI constants and delegate shapes match the audited source", () =>
{
    Check(Win11AppRouteAbi.InterfaceId == "ab3d4648-e242-459f-b02f-541c70306324" &&
        Win11AppRouteAbi.SetSlot == 25 && Win11AppRouteAbi.GetSlot == 26 && Win11AppRouteAbi.RenderFlow == 0,
        "Native ABI drift");
    var set = typeof(BoundWin11AppRoute).GetNestedType("SetAppFn", BindingFlags.NonPublic)!.GetMethod("Invoke")!;
    var get = typeof(BoundWin11AppRoute).GetNestedType("GetAppFn", BindingFlags.NonPublic)!.GetMethod("Invoke")!;
    Check(set.ReturnType == typeof(int) && get.ReturnType == typeof(int), "HRESULT no longer preserved");
    Check(set.GetParameters().Select(x => x.ParameterType).SequenceEqual(new[] { typeof(IntPtr), typeof(uint), typeof(int), typeof(int), typeof(IntPtr) }), "Setter signature drift");
    Check(get.GetParameters().Select(x => x.ParameterType).SequenceEqual(new[] { typeof(IntPtr), typeof(uint), typeof(int), typeof(int), typeof(IntPtr).MakeByRefType() }) && get.GetParameters()[4].IsOut, "Getter signature drift");
});

Run("native source exposes only route operations and scoped initialization", () =>
{
    var names = typeof(BoundWin11AppRoute).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Select(x => x.Name).Order().ToArray();
    Check(names.SequenceEqual(new[] { "CheckIdentity", "Dispose", "Get", "Set" }), "Unexpected native mutation surface");
    var imports = typeof(BoundWin11AppRoute).GetMethods(BindingFlags.NonPublic | BindingFlags.Static)
        .Select(x => x.GetCustomAttribute<DllImportAttribute>()).Where(x => x is not null).Select(x => x!.Value).ToArray();
    Check(imports.Length == 3 && imports.All(x => x is "combase.dll"), "Unexpected native dependencies");
});

Run("runtime adapter accepts client releases without an exact build allowlist", () =>
{
    foreach (uint build in new uint[] {17134, 19045, 22000, 22621, 22631, 26100, 26200, 28000, 29000})
        AppRouteCompatibility.RequireClient(10, 0, build, 1);
    Throws<PlatformNotSupportedException>(() => AppRouteCompatibility.RequireClient(10, 0, 16299, 1));
    Throws<PlatformNotSupportedException>(() => AppRouteCompatibility.RequireClient(10, 0, 22621, 3));
    Throws<PlatformNotSupportedException>(() => AppRouteCompatibility.RequireClient(11, 0, 22621, 1));
});
Run("runtime activation chooses the interface present on Windows 10 and 11", () =>
{
    foreach (uint build in new uint[] {19045, 22631, 26100, 28000})
    {
        var calls = new List<Guid>();
        var expected = build < 22000 ? AppRouteCompatibility.DownlevelInterfaceId : Win11AppRouteAbi.InterfaceId;
        Check(AppRouteCompatibility.SelectInterface(build, iid => { calls.Add(iid); return 0; }) == expected && calls.Count == 1, "Incorrect preferred interface");
        calls.Clear();
        var fallback = build < 22000 ? Win11AppRouteAbi.InterfaceId : AppRouteCompatibility.DownlevelInterfaceId;
        Check(AppRouteCompatibility.SelectInterface(build, iid => { calls.Add(iid); return calls.Count == 1 ? AppRouteCompatibility.NoInterface : 0; }) == fallback && calls.Count == 2, "Unavailable interface did not select known alternative");
    }
});
Run("unknown interfaces and activation failures do not select an invented ABI", () =>
{
    Throws<PlatformNotSupportedException>(() => AppRouteCompatibility.SelectInterface(26100, _ => AppRouteCompatibility.NoInterface));
    var calls = 0;
    Throws<COMException>(() => AppRouteCompatibility.SelectInterface(26100, _ => { calls++; return unchecked((int)0x80070005); }));
    Check(calls == 1, "Activation failure incorrectly retried as another interface");
});

Run("native identity proof rejects a reused PID or a different application", () =>
{
    var a = new NativeSpotifyIdentity(42, 100, "sid", "policy", "image", "store");
    Check(a.Matches(new NativeSpotifyIdentity(42, 100, "sid", "policy", "image", "store")), "Exact identity mismatch");
    Check(!a.Matches(new NativeSpotifyIdentity(42, 101, "sid", "policy", "image", "store")), "PID reuse accepted");
    Check(!a.Matches(new NativeSpotifyIdentity(42, 100, "other-sid", "policy", "image", "store")), "Different user accepted");
    Check(!a.Matches(new NativeSpotifyIdentity(42, 100, "sid", "other-policy", "image", "store")), "Different app policy accepted");
    Check(!a.Matches(new NativeSpotifyIdentity(42, 100, "sid", "policy", "other-image", "store")), "Different executable accepted");
    Check(!a.Matches(new NativeSpotifyIdentity(42, 100, "sid", "policy", "image", "desktop")), "Different distribution accepted");
});

if (!OperatingSystem.IsWindows())
    Run("native adapter refuses non-Windows before process access or native calls", () =>
    {
        var calls = 0;
        var identity = new NativeSpotifyIdentity(42, 100, "sid", "policy", "image", "store");
        Throws<PlatformNotSupportedException>(() => { using var adapter = new BoundWin11AppRoute(identity,
            _ => { calls++; return identity; }); });
        Check(calls == 0, "Non-Windows guard came too late");
    });

FileJournalHandleTests.Run(Run);

Console.WriteLine($"PASS {passed} transaction/native-contract scenarios; Windows interop compiled only, no Windows or hardware execution.");

sealed class MemoryJournal : IDurableRouteJournal
{
    public RouteRecord? Current;
    public Func<RouteRecord, bool>? FailWhen;
    public Action<RouteRecord>? AfterAppend;
    public RouteRecord? ReadLatest() => Current is null ? null : Current with { Roles = Current.Roles.ToArray() };
    public void Append(RouteRecord record)
    {
        if (FailWhen?.Invoke(record) == true) throw new IOException("Injected durable-write failure");
        Current = record with { Roles = record.Roles.ToArray() };
        AfterAppend?.Invoke(record);
    }
}

sealed class FakePlatform : IVerifiedSpotifyResolver, ISelectedEndpointVerifier, ISessionObserver
{
    public SpotifyProcess Live = new(4242, 638954700000000000, "test-user-sid", "verified-spotify-policy-key", "verified-spotify-image", "desktop");
    public BaseRenderEndpoint Endpoint = new("trusted-base-render", "opaque-policy-wrapper-of-base-render", "test-base-pnp", "test-signed-base-driver", true, true, true);
    public string?[] Originals = [null, "original-custom-device", ""];
    public string?[] Values = [null, "original-custom-device", ""];
    public readonly List<(RenderRole Role, string? Value)> Writes = [];
    public RenderRole? GetFailure;
    public int FailSetCall;
    public bool FailAfterWrite;
    public int CrashOnSet;
    public string? PolicyPath;
    public Action<RenderRole, string?>? BeforeSet;
    public string ObservationMode = "good";
    public int ObserverCalls;
    public TimeSpan ObservationBudget;
    public OwnedRouteTransaction Controller(IDurableRouteJournal journal) => new(this, this, this, journal);
    public void LoadPolicy() => Values = JsonSerializer.Deserialize<string?[]>(File.ReadAllText(PolicyPath!))!;
    public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected)
    {
        if (expected != Live) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        return new Bound(this, expected);
    }
    public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected) => Endpoint;
    public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait)
    {
        ObserverCalls++; ObservationBudget = maximumWait;
        var identity = ObservationMode == "wrong-process" ? Live with { StartTimeUtcTicks = 1 } : Live;
        var session = new RenderSession(identity, ObservationMode == "blank-session" ? "" : "fresh-session",
            ObservationMode == "wrong-endpoint" ? "physical" : Endpoint.Id, ObservationMode != "no-active");
        return new SessionObservation(ObservationMode != "incomplete", identity,
            ObservationMode == "stale" ? DateTimeOffset.UtcNow.AddMinutes(-1) : DateTimeOffset.UtcNow,
            ObservationMode == "mixed" ? [session, session with { SessionInstanceId = "second", EndpointId = "other" }] : [session]);
    }
    private sealed class Bound(FakePlatform platform, SpotifyProcess identity) : IBoundSpotifyPolicy
    {
        public SpotifyProcess Identity => identity;
        public SpotifyProcess CheckLiveIdentity() => platform.Live;
        public string? Get(RenderRole role)
        {
            if (platform.GetFailure == role) throw new IOException("Injected failed getter");
            return platform.Values[(int)role];
        }
        public void Set(RenderRole role, string? endpoint)
        {
            if (CheckLiveIdentity() != identity) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
            platform.BeforeSet?.Invoke(role, endpoint);
            platform.Writes.Add((role, endpoint));
            if (platform.Writes.Count == platform.FailSetCall && !platform.FailAfterWrite) throw new IOException("Injected setter failure");
            platform.Values[(int)role] = endpoint;
            if (platform.PolicyPath is not null) File.WriteAllText(platform.PolicyPath, JsonSerializer.Serialize(platform.Values));
            if (platform.Writes.Count == platform.CrashOnSet) Environment.Exit(91);
            if (platform.Writes.Count == platform.FailSetCall && platform.FailAfterWrite) throw new IOException("Injected uncertain setter failure");
        }
        public void Dispose() { }
    }
}
