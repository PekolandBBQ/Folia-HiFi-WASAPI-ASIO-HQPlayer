using System.Text.Json;

namespace Folia.Capture;

// Device-free substitutes for Windows-only boundaries. Tests compile the production
// CaptureEngine, OwnedFormatLease and evidence records; no native helper is executed.
internal static class EngineScenario
{
    internal static readonly CaptureFormat BaseFormat = new(48000, 2, 32, 32, 8, 384000, "float", 3, CaptureFormat.FloatSubtype.ToString());
    internal static readonly RenderSessionEvidence Spotify = new(12, "inactive", "Spotify", @"C:\Spotify\Spotify.exe", false, true, 123,
        StartedAtUtcTicks: "621355968001230000");
    internal static readonly List<string> Trace = [];
    internal static readonly List<CaptureSession> Sessions = [];
    internal static readonly List<NativeFormatLease> Endpoints = [];
    internal static Func<string, Exception?>? AcquisitionFailure;
    internal static Func<string, Exception?>? PostRegistrationFailure;
    internal static Func<ConfigurationEvidence, int, ConfigurationEvidence>? Inspection;
    internal static Func<int, RenderSessionEvidence>? ProcessObservation;
    internal static string? ConstructorFailure, StartFailure, StopFailure, ReleaseFailure;
    internal static int InspectionCount;
    internal static void Reset()
    {
        Trace.Clear(); Sessions.Clear(); Endpoints.Clear(); AcquisitionFailure = null; PostRegistrationFailure = null; Inspection = null;
        NativeFormatLease.RenderSessions = new(20, 123);
        ConstructorFailure = StartFailure = StopFailure = ReleaseFailure = null; InspectionCount = 0;
        ProcessObservation = null;
    }
}

internal static class EndpointInspector
{
    internal static DefaultEndpointEvidence[] Defaults() => [];
    internal static object DefaultsObject(DefaultEndpointEvidence[] defaults) => defaults;
    internal static RenderSessionEvidence[] SpotifyProcesses() => [EngineScenario.Spotify];
    internal static RenderSessionEvidence SpotifyProcess(int pid) => EngineScenario.ProcessObservation?.Invoke(pid)
        ?? EngineScenario.Spotify with { State = "running" };
    internal static EndpointInventory<EndpointEvidence> Devices() => new([], new("complete", 0, 0, 0, 0, 0, null));
    internal static ConfigurationEvidence Inspect(string captureId, string renderId, string? outputId, OwnedFormatLease? lease = null)
    {
        var evidence = lease?.ReadEvidence();
        var capture = new EndpointEvidence(captureId, "CABLE Output", "VB-Audio Virtual Cable", "capture", "capture-instance",
            evidence?.After.Capture ?? EngineScenario.BaseFormat, true, BaseIdentity: new("verified", "base-owner"));
        var render = new EndpointEvidence(renderId, "CABLE Input", "VB-Audio Virtual Cable", "render", "render-instance",
            evidence?.After.Render ?? EngineScenario.BaseFormat, true, BaseIdentity: new("verified", "base-owner"));
        string[] issues = evidence == null ? ["CAPTURE_RATE_MISMATCH", "RENDER_RATE_MISMATCH"] : [];
        var sessions = new[] { EngineScenario.Spotify }.Concat(EngineScenario.Endpoints
            .Where(endpoint => endpoint.Identity is { } id && id.EndpointId == renderId)
            .Select(endpoint => endpoint.Observed with
            { IsOwnedFormatLease = NativeFormatLease.RenderSessions.Owns(endpoint.Identity!.Value, endpoint.Observed),
                IsOwnedActiveSilentFormatLease = NativeFormatLease.RenderSessions.Owns(endpoint.Identity!.Value, endpoint.Observed) && endpoint.Observed.State == "active" })).ToArray();
        var route = RoutePolicy.Evaluate(sessions, false, false);
        issues = issues.Concat(route.Issues).Distinct().ToArray();
        var configuration = new ConfigurationEvidence(issues.Length == 0, issues, capture, render, route,
            sessions, [], TemporaryFormatLeaseEligible: route.Ready, FormatLease: evidence);
        EngineScenario.Trace.Add(lease == null ? "inspect:unleased" : "inspect:held");
        var count = ++EngineScenario.InspectionCount;
        return EngineScenario.Inspection?.Invoke(configuration, count) ?? configuration;
    }
}

internal sealed class NativeFormatLease(string endpointId, CaptureFormat format, FormatLeaseSessionIdentity? identity,
    string? endpointRole) : ITemporaryFormatEndpoint
{
    internal static FormatLeaseSessionRegistry RenderSessions { get; set; } = new(20, 123);
    internal FormatLeaseSessionIdentity? Identity => identity;
    internal RenderSessionEvidence Observed { get; set; } = new(20, "active", "folia-capture", @"C:\folia-capture.exe", false, true, 123);
    internal int Disposals { get; private set; }
    internal string EndpointId => endpointId;
    internal CaptureFormat? ReadbackOverride;
    internal static NativeFormatLease Acquire(string endpointId, CaptureFormat before, Guid groupingId, bool trackRenderSession = false,
        string? endpointRole = null)
    {
        EngineScenario.Trace.Add("acquire:" + endpointId);
        if (EngineScenario.AcquisitionFailure?.Invoke(endpointId) is { } error) throw error;
        FormatLeaseSessionIdentity? identity = trackRenderSession ? new(endpointId, Guid.NewGuid().ToString(), groupingId) : null;
        if (identity is { } created) { RenderSessions.Register(created); RenderSessions.MarkSilentStarted(created, 621355968001230000); }
        var endpoint = new NativeFormatLease(endpointId, FormatLeasePolicy.Request(before), identity, endpointRole);
        EngineScenario.Endpoints.Add(endpoint);
        try
        {
            if (EngineScenario.PostRegistrationFailure?.Invoke(endpointId) is { } after) throw after;
            return endpoint;
        }
        catch (Exception failure) { throw FormatLeasePolicy.CleanupFailure(failure, endpoint.Dispose); }
    }
    public CaptureFormat ReadCurrent()
    {
        if (Disposals != 0) throw new CaptureFailure("FORMAT_LEASE_CLOSED");
        return FormatLeasePolicy.RequireReadback(ReadbackOverride ?? format, 448, format, endpointRole);
    }
    public void Dispose()
    {
        Disposals++; EngineScenario.Trace.Add("release:" + endpointId);
        if (EngineScenario.ReleaseFailure == endpointId)
        {
            if (identity is { } failed) RenderSessions.Forget(failed);
            throw new CaptureFailure("TEST_RELEASE_FAILED", unchecked((int)0x80004005));
        }
        Observed = Observed with { State = "inactive" };
        if (identity is { } released) RenderSessions.Retire(released);
    }
}

internal sealed class CaptureSession : IDisposable
{
    // This legacy suite exercises readback/cleanup only, not position-epoch starts.
    internal CapturePositionEpochEvidence StartPositionEpoch(string intent) => throw new NotSupportedException();
    internal void RequirePositionEpoch() => throw new CaptureFailure("CAPTURE_POSITION_EPOCH_UNSUPPORTED_TEST_DOUBLE");
    internal CapturePositionEpochEvidence BeginPositionEpoch(string intent) => throw new CaptureFailure("CAPTURE_POSITION_EPOCH_UNSUPPORTED_TEST_DOUBLE");

    internal ConfigurationEvidence Configuration => configuration;
    internal void RequirePlayingSeek() => throw new CaptureFailure("CAPTURE_SEEK_UNSUPPORTED_TEST_DOUBLE");
    internal CaptureResetBoundary ParkForSeek() => throw new CaptureFailure("CAPTURE_SEEK_UNSUPPORTED_TEST_DOUBLE");
    internal bool RetainedDeviceHealthy => false;
    internal void ReleaseRetainedDevice() { }
    internal CaptureSession Reopen(CaptureLease lease, ConfigurationEvidence configuration,
        Action<CaptureSession, string> failure, string? delivery) => throw new CaptureFailure("CAPTURE_SEEK_UNSUPPORTED_TEST_DOUBLE");

    internal readonly CaptureLease Lease;
    internal readonly string CaptureDeviceId, RenderDeviceId;
    internal readonly string? OutputDeviceId;
    internal readonly SpotifyProcessLease SpotifyProcess;
    private readonly CaptureLifecycle lifecycle = new();
    private readonly Action<CaptureSession, string> onFailure;
    private ConfigurationEvidence configuration;
    private bool disposed;
    private readonly object stateGate = new();
    private CaptureFailureDiagnostic? terminalFailure;
    internal readonly PcmDeliveryGate Delivery;
    internal long CapturedFrames;
    internal long DeliveredFrames = 0;
    internal int Disposals { get; private set; }
    internal bool Terminal => lifecycle.Snapshot.Terminal;
    internal bool BootstrapPending => Delivery.State is "discarding" or "buffering";
    internal bool FormatLeaseReleased => configuration.FormatLease?.State == "released";
    internal CaptureSession(CaptureLease lease, string captureId, string renderId, string? outputId,
        ConfigurationEvidence configuration, SpotifyProcessLease process, Action<CaptureSession, string> onFailure,
        string? bootstrapDelivery = null)
    {
        Lease = lease; CaptureDeviceId = captureId; RenderDeviceId = renderId; OutputDeviceId = outputId;
        this.configuration = configuration; SpotifyProcess = process; this.onFailure = onFailure;
        Delivery = new(705600, bootstrapDelivery);
        EngineScenario.Trace.Add("session:create");
        if (EngineScenario.ConstructorFailure is { } code) throw new CaptureFailure(code);
        lifecycle.MarkPrepared(); EngineScenario.Sessions.Add(this);
    }
    internal void RequireStartable()
    {
        var state = lifecycle.Snapshot;
        if (state.Terminal) throw new CaptureFailure(state.ErrorCode ?? "CAPTURE_CLOSED");
    }
    internal void Start()
    {
        RequireStartable();
        EngineScenario.Trace.Add("session:start");
        if (EngineScenario.StartFailure is { } code) throw new CaptureFailure(code);
        if (lifecycle.RequestStart()) lifecycle.MarkRunning();
    }
    internal object Snapshot() => new { Lease.Session, Lease.Generation, state = lifecycle.Snapshot.State,
        configuration, formatLeaseReleased = FormatLeaseReleased, spotifyProcess = SpotifyProcess,
        bootstrapMode = Delivery.BootstrapDelivery == null ? null : "paused-source", bootstrapDelivery = Delivery.BootstrapDelivery,
        deliveryState = Delivery.State, queuedBytes = Delivery.QueuedBytes };
    internal CaptureTerminalEvidence TerminalEvidence(bool cleanupConfirmed)
    {
        lock (stateGate)
        {
            var life = lifecycle.Snapshot;
            return new(Lease.Session, Lease.Generation, life.State, life.ErrorCode,
                CapturedFrames, DeliveredFrames, Delivery.QueuedBytes,
                Delivery.BootstrapDelivery == null ? null : "paused-source", Delivery.BootstrapDelivery,
                Delivery.State, cleanupConfirmed, Hresult: terminalFailure?.Hresult, FailureStage: terminalFailure?.FailureStage,
                FormatLeaseReadback: terminalFailure?.FormatLeaseReadback);
        }
    }
    internal void ObserveRoute(ConfigurationEvidence next)
    {
        if (!BootstrapPending || next.Sessions.Any(item => item.State != "expired" && RoutePolicy.IsSpotify(item)))
            SpotifyProcess.RequireUnchanged(next.Sessions);
        configuration = next;
    }
    internal void ConfirmStartValidation(ConfigurationEvidence configuration)
    {
        lock (stateGate)
        {
            RequireStartable();
            if (lifecycle.Snapshot.State != "running") throw new CaptureFailure("CAPTURE_STATE_INVALID");
            ObserveRoute(configuration); Delivery.ConfirmStartValidation();
        }
    }
    internal void RequirePromotable()
    {
        RequireStartable();
        if (Delivery.BootstrapDelivery == "discard") throw new CaptureFailure("CAPTURE_BOOTSTRAP_DISCARD_ONLY");
        if (lifecycle.Snapshot.State != "running" || Delivery.State != "buffering") throw new CaptureFailure("CAPTURE_PROMOTION_INVALID");
    }
    internal void Promote() { lock (stateGate) { RequirePromotable(); Delivery.Promote(); } }
    internal void ObserveFormatLeaseReleased()
    { if (configuration.FormatLease is { } evidence) configuration = configuration with { FormatLease = evidence with { State = "released" } }; }
    internal void ObserveFormatLeaseReleaseFailed()
    { if (configuration.FormatLease is { } evidence) configuration = configuration with { FormatLease = evidence with { State = "release-failed" } }; }
    internal void Fail(string code) => Fail(CaptureFailureDiagnostic.For(code, null, null));
    internal void Fail(CaptureFailure failure) => Fail(CaptureFailureDiagnostic.For(failure.Code, failure, null));
    internal void Fail(CaptureFailureDiagnostic failure)
    {
        lock (stateGate)
        {
            if (!lifecycle.Fail(failure.Code)) return;
            terminalFailure = failure; Delivery.Close();
        }
        onFailure(this, failure.Code);
    }
    internal void EmitStaleFailure(string code) => onFailure(this, code);
    public void Dispose()
    {
        if (disposed) return; disposed = true; Disposals++;
        lock (stateGate) { lifecycle.Close(); Delivery.Close(); }
        EngineScenario.Trace.Add("session:dispose");
        if (EngineScenario.StopFailure is { } code) throw new CaptureFailure(code);
    }
}
