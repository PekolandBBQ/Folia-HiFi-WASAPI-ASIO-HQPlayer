using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;

internal static class ServiceBoundary
{
    internal static int Run()
    {
        CheckArmThenRestore(); CheckStaleEnvelope(); return 2;
    }
    private static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    private static ServiceReply Send(ProductRouteService service, string command, object payload) =>
        service.Dispatch(JsonSerializer.Serialize(new { id = 1, command, payload }));
    private static ServiceReply Acquire(ProductRouteService service) => Send(service, "acquire", new {
        session = "s1", generation = 2, captureDeviceId = "capture", renderDeviceId = "render", sourcePaused = true,
        expectedSpotifyProcessId = 12, expectedSpotifyStartTimeUtcTicks = Backend.Process.StartTimeUtcTicks.ToString(),
        sourceDeviceId = "device", expectedSourceUri = (string?)null });
    private static object Proof(string session = "s1") => new { captureSession = session, captureGeneration = 9,
        endpointId = "render", sessionInstanceId = "keeper", groupingId = "26377ba7-2d95-407a-b2b7-7131377305c2",
        processId = 20, startedAtUtcTicks = "639271242001234567" };
    private static void CheckArmThenRestore()
    {
        var backend = new Backend(); using var service = new ProductRouteService(backend);
        var acquired = Acquire(service); Check(acquired.Ok && acquired.State == "heldPaused", "Could not establish paused route");
        var id = JsonSerializer.SerializeToElement(acquired.Lease).GetProperty("leaseId").GetString()!;
        backend.Lifetime.ExpectKeeper = true; backend.Lifetime.Events.Clear();
        var armed = Send(service, "armCaptureInterval", new { session = "s1", generation = 2, leaseId = id, ownedSilentRenderLease = Proof() });
        Check(armed.Ok && armed.IntervalArmed && armed.IntervalGeneration == 2 && !armed.Ready, "Attested arm failed or published readiness early");
        Check(backend.Lifetime.Events.SequenceEqual(new[] { "bind", "pause", "arm" }), "Proof did not bind before existing pause snapshot and arm");
        Check(backend.Lifetime.Proof?.CaptureGeneration == 9, "Capture generation was confused with route generation");
        backend.Lifetime.KeeperAlive = false;
        var resume = Send(service, "authorizeResume", new { session = "s1", generation = 2, leaseId = id,
            captureStarted = true, monitorGainZero = true, selectedSourceUri = "spotify:track:t" });
        Check(!resume.Ok && !resume.Ready && !resume.ResumeAuthorized, "Stopped keeper authorized source resume");
        var restored = Send(service, "release", new { session = "s1", generation = 2, leaseId = id });
        Check(restored.Ok && restored.ExactOriginalRolesRestored && restored.State == "restored", "Keeper loss blocked internal restoration");
        Check(backend.Lifetime.Values.All(item => item is null) && backend.Lifetime.SetterCalls == 4,
            "Restore did not return both exact original roles");
        Console.WriteLine("PASS service binds proof before arm and restores originals after keeper loss");
    }
    private static void CheckStaleEnvelope()
    {
        var backend = new Backend(); using var service = new ProductRouteService(backend);
        var acquired = Acquire(service); var id = JsonSerializer.SerializeToElement(acquired.Lease).GetProperty("leaseId").GetString()!;
        backend.Lifetime.Events.Clear();
        foreach (var request in new object[] {
            new { session = "s1", generation = 1, leaseId = id, ownedSilentRenderLease = Proof() },
            new { session = "s1", generation = 2, leaseId = id, ownedSilentRenderLease = Proof("old-session") } }) {
            var reply = Send(service, "armCaptureInterval", request);
            Check(!reply.Ok && !reply.IntervalArmed && !reply.Ready, "Stale proof or route generation armed an interval");
        }
        Check(backend.Lifetime.Proof is null && backend.Lifetime.Events.Count == 0, "Rejected proof mutated silent session ownership");
        Console.WriteLine("PASS stale route generation and stale capture session never bind proof");
    }
    private sealed class Backend : IProductRouteBackend
    {
        internal static readonly SpotifyProcess Process = new(12, 639271242000000000, "sid", "spotify-policy", "spotify-image", "desktop");
        internal readonly Lifetime Lifetime = new();
        public ProductCapabilities Capabilities { get; } = new(true, true, true, true, true, [], IntervalIsolation: true, OwnedSilentRenderLease: true);
        public ProductDiscovery Inspect(RouteSelection selection) => new(Process, new("render", "policy-render", "pnp", "driver", true, true, true),
            selection, [null, null, null], true, true, true, true, true, true);
        public IProductRouteLifetime Open(ProductDiscovery discovery) => Lifetime;
    }
    private sealed class Lifetime : IProductRouteLifetime, IVerifiedSpotifyResolver, IBoundSpotifyPolicy, ISelectedEndpointVerifier, ISessionObserver, IDurableRouteJournal
    {
        internal readonly List<string> Events = [];
        internal readonly string?[] Values = [null, null, null];
        internal bool ExpectKeeper, KeeperAlive = true;
        internal int SetterCalls;
        internal OwnedSilentRenderLeaseProof? Proof;
        private RouteRecord? record;
        public IVerifiedSpotifyResolver Resolver => this;
        public ISelectedEndpointVerifier EndpointVerifier => this;
        public ISessionObserver Observer => this;
        public IDurableRouteJournal Journal => this;
        public SpotifyProcess Identity => Backend.Process;
        public SpotifyProcess CheckLiveIdentity() => Identity;
        public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected) => this;
        public string? Get(RenderRole role) => Values[(int)role];
        public void Set(RenderRole role, string? endpoint) { Values[(int)role] = endpoint; SetterCalls++; }
        public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected) => expected;
        public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) => new(true, Identity, DateTimeOffset.UtcNow,
            [new(Identity, "spotify-instance", "render", true)]);
        public RouteRecord? ReadLatest() => record;
        public void Append(RouteRecord value) => record = value;
        public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord value) => new(value.TransactionId, value.CurrentProcess,
            new string('a', 64), 1, "file", true, true, true);
        public void ValidateOwnership(PreparedRetention value) { }
        public void ValidateApplyAuthority() { if (Proof is not null && !KeeperAlive) throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_LOST"); }
        public void VerifyPausedSource(OwnedPlaybackTarget source) {
            Events.Add("pause");
            if (ExpectKeeper && !source.RequirePcmStopped && Proof is null) throw new RouteBlockedException("UNATTESTED_KEEPER");
        }
        public void VerifyRestoredTerminal(RouteRecord terminal, PreparedRetention value) { }
        public ProductDefaultStatus ReadDefaultStatus() => new(true, [null, null, null], [null, null, null]);
        public bool IntervalIsolated => IntervalGeneration != 0 && KeeperAlive;
        public int IntervalGeneration { get; private set; }
        public string? IntervalId { get; private set; }
        public void BindOwnedSilentRenderLease(OwnedSilentRenderLeaseProof proof) { Events.Add("bind"); Proof = proof; }
        public void ArmCaptureInterval(string session, int generation) { Events.Add("arm"); IntervalGeneration = generation; IntervalId = "interval"; }
        public void Dispose() { }
    }
}
