namespace Folia.Capture;

internal sealed class CaptureSession : IDisposable
{
    internal readonly CaptureLease Lease;
    internal readonly string CaptureDeviceId, RenderDeviceId;
    internal readonly string? OutputDeviceId;
    internal readonly ConfigurationEvidence Configuration;
    internal readonly SpotifyProcessLease SpotifyProcess;
    private readonly PcmDeliveryGate ring;
    private readonly CaptureLifecycle lifecycle = new();
    private readonly Action<CaptureSession, string> onFailure;
    private readonly CapturePipe pipe;
    internal readonly CaptureDeviceOwner DeviceOwner = null!;
    private bool detached;
    private bool positionEpochUsed;
    private CapturePositionEpochEvidence? positionEpoch;
    internal bool ReusedDeviceOwner { get; }
    private readonly object stateGate = new();
    private ConfigurationEvidence latestConfiguration;
    private long routeObservedAtUnixMs;
    private long capturedFrames, devicePosition, qpcPosition;
    private readonly ShortGapPcmWriter packets;
    private CaptureFailureDiagnostic? terminalFailure;
    private int closed;
    internal bool Terminal => lifecycle.Snapshot.Terminal;
    internal bool BootstrapPending => ring.State is "discarding" or "buffering";
    private long CapturedFrames => ring.BootstrapDelivery == "discard" ? Interlocked.Read(ref capturedFrames) : ring.AcceptedFrames;
    internal bool FormatLeaseReleased
    { get { lock (stateGate) return latestConfiguration.FormatLease?.State == "released"; } }

    internal CaptureSession(CaptureLease lease, string captureId, string renderId, string? outputId,
        ConfigurationEvidence configuration, SpotifyProcessLease spotifyProcess, Action<CaptureSession, string> onFailure,
        string? bootstrapDelivery = null, CaptureDeviceOwner? retainedDevice = null)
    {
        Lease = lease; CaptureDeviceId = captureId; RenderDeviceId = renderId; OutputDeviceId = outputId;
        Configuration = latestConfiguration = configuration; SpotifyProcess = spotifyProcess; this.onFailure = onFailure;
        ring = new(44100 * 8 * 2, bootstrapDelivery,
            bootstrapDelivery == "buffer" ? 27165600 : null, bootstrapDelivery == "buffer" ? 75000 : 0,
            holdForStartValidation: true);
        packets = new ShortGapPcmWriter(ring);
        routeObservedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        pipe = new CapturePipe(lease.PipeName, ring, (code, error) => Fail(CaptureFailureDiagnostic.For(code, error, "pipe")));
        ReusedDeviceOwner = retainedDevice != null;
        try
        {
            DeviceOwner = retainedDevice ?? new CaptureDeviceOwner(() => new ProcessCaptureDevice(spotifyProcess, configuration),
                ProcessCaptureDevice.ConfigureThread);
            DeviceOwner.Bind(this);
            pipe.Begin();
        }
        catch (TimeoutException) { Fail(CaptureFailureDiagnostic.For("CAPTURE_INITIALIZE_TIMEOUT", null, "initialize")); Dispose(); throw new CaptureFailure("CAPTURE_INITIALIZE_TIMEOUT"); }
        catch { Dispose(); throw; }
    }

    internal void RequireStartable()
    {
        var state = lifecycle.Snapshot;
        if (state.Terminal) throw new CaptureFailure(state.ErrorCode ?? "CAPTURE_CLOSED");
    }

    internal void Start()
    {
        RequireStartable();
        if (!pipe.Connected) throw new CaptureFailure("CAPTURE_PIPE_NOT_CONNECTED");
        if (lifecycle.RequestStart()) DeviceOwner.Start(this);
        try { lifecycle.Running.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
        catch (TimeoutException) { Fail(CaptureFailureDiagnostic.For("CAPTURE_START_TIMEOUT", null, "start")); throw new CaptureFailure("CAPTURE_START_TIMEOUT"); }
    }

    internal object Snapshot()
    {
        lock (stateGate)
        {
        var life = lifecycle.Snapshot;
        var buffer = ring.BufferSnapshot;
        return new { Lease.Session, Lease.Generation, Lease.PipeName, state = life.State, errorCode = life.ErrorCode,
            captureDeviceId = CaptureDeviceId, renderDeviceId = RenderDeviceId, configuration = latestConfiguration,
            spotifyProcess = SpotifyProcess, routeObservedAtUnixMs, startValidated = ring.StartValidated,
            bootstrapMode = ring.BootstrapDelivery == null ? null : "paused-source", bootstrapDelivery = ring.BootstrapDelivery,
            deliveryState = buffer.State,
            bootstrapTimeoutMs = ring.BootstrapDelivery == "buffer" ? (int?)75000 : null,
            bootstrapQueueCapacityBytes = ring.BootstrapDelivery == "buffer" ? (int?)27165600 : null,
            bootstrapPrefixFrames = buffer.BootstrapPrefixFrames,
            sampleRate = 44100, channels = 2, bitDepth = 32, sampleFormat = "s32le", sampleRateConversion = false,
            actualMixFormat = Configuration.Capture.MixFormat, pipeConnected = pipe.Connected,
            formatLeaseReleased = latestConfiguration.FormatLease?.State == "released",
            capturedFrames = packets.ReceivedFrames, concealedFrames = packets.ConcealedFrames, discontinuities = packets.Discontinuities, lastGapFrames = packets.LastGapFrames, deliveredFrames = pipe.DeliveredFrames,
            queuedBytes = buffer.QueuedBytes, queueCapacityBytes = buffer.CapacityBytes,
            lastDevicePositionFrames = Interlocked.Read(ref devicePosition), lastQpcPosition100ns = Interlocked.Read(ref qpcPosition),
            initialDiscontinuity = packets.InitialDiscontinuity, captureDeviceOwnerReused = ReusedDeviceOwner,
            seekResetBoundary = ReusedDeviceOwner ? DeviceOwner.LastReset : null,
            positionEpoch = positionEpoch == null ? null : new { positionEpoch.PositionIntentId, positionEpoch.CutSequence } };
        }
    }

    internal CaptureTerminalEvidence TerminalEvidence(bool cleanupConfirmed)
    {
        lock (stateGate)
        {
            var life = lifecycle.Snapshot;
            var buffer = ring.BufferSnapshot;
            return new(Lease.Session, Lease.Generation, life.State, life.ErrorCode,
                packets.ReceivedFrames, pipe.DeliveredFrames, buffer.QueuedBytes,
                ring.BootstrapDelivery == null ? null : "paused-source", ring.BootstrapDelivery, buffer.State,
                cleanupConfirmed, Hresult: terminalFailure?.Hresult, FailureStage: terminalFailure?.FailureStage,
                FormatLeaseReadback: terminalFailure?.FormatLeaseReadback, ConcealedFrames: packets.ConcealedFrames,
                Discontinuities: packets.Discontinuities, LastGapFrames: packets.LastGapFrames);
        }
    }

    internal void ObserveRoute(ConfigurationEvidence configuration)
    {
        if (!BootstrapPending || configuration.Sessions.Any(item => item.State != "expired" && RoutePolicy.IsSpotify(item)))
            SpotifyProcess.RequireUnchanged(configuration.Sessions);
        if (configuration.Capture.MixFormat != Configuration.Capture.MixFormat) throw new CaptureFailure("CAPTURE_FORMAT_CHANGED");
        lock (stateGate) { latestConfiguration = configuration; routeObservedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    }

    internal void ConfirmStartValidation(ConfigurationEvidence configuration)
    {
        // Fail/Dispose share this lock. A late readback cannot publish a dead
        // generation, and buffer bootstrap still requires independent promotion.
        lock (stateGate)
        {
            RequireStartable();
            if (lifecycle.Snapshot.State != "running") throw new CaptureFailure("CAPTURE_STATE_INVALID");
            ObserveRoute(configuration);
            ring.ConfirmStartValidation();
        }
    }

    internal void RequirePromotable()
    {
        RequireStartable();
        if (ring.BootstrapDelivery == "discard") throw new CaptureFailure("CAPTURE_BOOTSTRAP_DISCARD_ONLY");
        if (lifecycle.Snapshot.State != "running" || ring.State != "buffering")
            throw new CaptureFailure("CAPTURE_PROMOTION_INVALID");
    }

    internal void Promote()
    {
        // Terminal lifecycle transitions and delivery publication share one lock.
        // A route proof finishing after Fail/Dispose can never reopen this gate.
        lock (stateGate) { RequirePromotable(); ring.Promote(); }
    }

    // The control STA calls this only after both owned format clients have been disposed.
    // Keep the prior readback as historical evidence; this is not a post-release OS readback.
    internal void ObserveFormatLeaseReleased()
    {
        lock (stateGate)
            if (latestConfiguration.FormatLease is { } evidence)
                latestConfiguration = latestConfiguration with { FormatLease = evidence with { State = "released" } };
    }

    internal void ObserveFormatLeaseReleaseFailed()
    {
        lock (stateGate)
            if (latestConfiguration.FormatLease is { } evidence)
                latestConfiguration = latestConfiguration with { FormatLease = evidence with { State = "release-failed" } };
    }

    internal void Fail(string code) => Fail(CaptureFailureDiagnostic.For(code, null, null));
    internal void Fail(CaptureFailure failure) => Fail(CaptureFailureDiagnostic.For(failure.Code, failure, null));

    internal void Fail(CaptureFailureDiagnostic failure)
    {
        lock (stateGate)
        {
            if (!lifecycle.Fail(failure.Code)) return;
            terminalFailure = failure;
            ring.Close();
        }
        pipe.Dispose();
        // The notification contains no audio. Program queues it, so capture never blocks on stdout.
        onFailure(this, failure.Code);
    }

    internal void MarkPrepared()
    {
        if (!lifecycle.MarkPrepared()) throw new CaptureFailure("CAPTURE_CLOSED");
    }

    internal void MarkRunning()
    {
        ring.StartBootstrapDeadline();
        if (!lifecycle.MarkRunning()) throw new CaptureFailure("CAPTURE_CLOSED");
    }

    internal bool Discarding => ring.Discarding;
    internal void CheckBootstrapDeadline() => ring.CheckBootstrapDeadline();

    internal void AcceptPacket(ReadOnlySpan<byte> bytes, int frames, long position, long qpc, bool discontinuity)
    {
        lock (stateGate)
        {
            // A packet already acquired before cancellation is released by the
            // device owner; it never becomes a fault or enters a new generation.
            if (Terminal) return;
            packets.Accept(bytes, frames, position, qpc, discontinuity);
            if (ring.Discarding) Interlocked.Add(ref capturedFrames, frames);
            Interlocked.Exchange(ref devicePosition, position);
            Interlocked.Exchange(ref qpcPosition, qpc);
        }
    }

    internal void RequirePlayingSeek()
    {
        lock (stateGate)
        {
            RequireStartable();
            if (lifecycle.Snapshot.State != "running" || ring.State != "live" || !ring.StartValidated)
                throw new CaptureFailure("CAPTURE_SEEK_NOT_PLAYING");
        }
    }

    internal void RequireFreshPositionEpoch()
    {
        lock (stateGate)
        {
            RequireStartable();
            if (positionEpochUsed || lifecycle.Snapshot.State == "running" || ring.BootstrapDelivery != "buffer"
                || ring.StartValidated || CapturedFrames != 0 || pipe.DeliveredFrames != 0 || ReusedDeviceOwner)
                throw new CaptureFailure("CAPTURE_POSITION_EPOCH_INVALID");
        }
    }

    internal void ObserveFreshPositionEpoch(CapturePositionEpochEvidence evidence)
    { lock (stateGate) { RequireFreshPositionEpoch(); positionEpochUsed = true; positionEpoch = evidence; } }

    internal CapturePositionEpochEvidence StartPositionEpoch(string intent)
    {
        RequireFreshPositionEpoch();
        if (!pipe.Connected || !lifecycle.RequestStart()) throw new CaptureFailure("CAPTURE_STATE_INVALID");
        return DeviceOwner.StartPositionEpoch(this, intent);
    }

    internal void RequirePositionEpoch()
    {
        lock (stateGate)
        {
            RequireStartable();
            if (positionEpochUsed || lifecycle.Snapshot.State != "running" || ring.State != "buffering"
                || !ring.StartValidated || pipe.DeliveredFrames != 0)
                throw new CaptureFailure("CAPTURE_POSITION_EPOCH_INVALID");
        }
    }

    internal void CutUnpublishedBootstrap()
    {
        lock (stateGate)
        {
            RequirePositionEpoch(); positionEpochUsed = true;
            ring.CutUnpublishedBootstrap();
            Interlocked.Exchange(ref capturedFrames, 0); Interlocked.Exchange(ref devicePosition, 0);
            Interlocked.Exchange(ref qpcPosition, 0); packets.Reset();
        }
    }

    internal void ObservePositionEpoch(CapturePositionEpochEvidence evidence)
    { lock (stateGate) { RequireStartable(); positionEpoch = evidence; } }

    internal CapturePositionEpochEvidence BeginPositionEpoch(string intent) => DeviceOwner.BeginPositionEpoch(this, intent);

    internal CaptureResetBoundary ParkForSeek()
    {
        RequirePlayingSeek();
        var boundary = DeviceOwner.Park(this);
        detached = true;
        return boundary;
    }

    internal void CloseGeneration()
    {
        lock (stateGate) { lifecycle.Close(); ring.Close(); }
        pipe.Dispose();
    }

    internal bool RetainedDeviceHealthy => detached && DeviceOwner.Healthy;
    internal void ReleaseRetainedDevice() => DeviceOwner.Dispose();
    internal CaptureSession Reopen(CaptureLease lease, ConfigurationEvidence configuration,
        Action<CaptureSession, string> failure, string? bootstrapDelivery) =>
        new(lease, CaptureDeviceId, RenderDeviceId, OutputDeviceId, configuration, SpotifyProcess,
            failure, bootstrapDelivery, DeviceOwner);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        CloseGeneration();
        if (!detached) DeviceOwner?.Dispose();
    }
}

