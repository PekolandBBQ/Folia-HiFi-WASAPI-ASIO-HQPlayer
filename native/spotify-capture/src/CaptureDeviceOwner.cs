using System.Collections.Concurrent;

namespace Folia.Capture;

// This is the only reusable part of capture: one initialized device on one STA.
// Generation state, PCM memory, pipes, and publication proofs belong to CaptureSession.
internal interface ICaptureDevice : IDisposable
{
    WaitHandle SamplesReady { get; }
    CaptureFormat Format { get; }
    void Start();
    void Stop();
    void Reset();
    void ClearScratch();
    bool ReadPacket(CaptureSession session);
}

internal sealed class CaptureDeviceOwner : IDisposable
{
    private sealed record Work(Action<ICaptureDevice> Action, TaskCompletionSource<bool> Completion, string Stage);
    private readonly ConcurrentQueue<Work> commands = new();
    private readonly AutoResetEvent commandReady = new(false);
    private readonly TaskCompletionSource<bool> initialized = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread thread;
    private readonly object gate = new();
    private CaptureSession? bound;
    private CaptureFailureDiagnostic? failure;
    private bool running, eventDisposed;
    private CaptureFailureDiagnostic? cleanupFailure;
    private int closing;
    private long resetSequence;
    internal CaptureFormat Format { get; private set; } = null!;
    internal CaptureResetBoundary? LastReset { get; private set; }
    internal bool Healthy { get { lock (gate) return failure == null && Volatile.Read(ref closing) == 0 && thread.IsAlive; } }
    internal CaptureFailureDiagnostic? Failure { get { lock (gate) return failure; } }

    internal CaptureDeviceOwner(Func<ICaptureDevice> createDevice, Action<Thread>? configureThread = null)
    {
        thread = new Thread(() => Run(createDevice)) { IsBackground = true, Name = "Folia VB-CABLE capture" };
        // Tests replace the device and apartment setup together; production always uses STA.
        (configureThread ?? (worker => worker.SetApartmentState(ApartmentState.STA)))(thread);
        thread.Start();
        try { initialized.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
        catch (TimeoutException) { Dispose(); throw new CaptureFailure("CAPTURE_INITIALIZE_TIMEOUT"); }
        catch { Dispose(); throw; }
    }

    internal void Bind(CaptureSession session) => Invoke(device =>
    {
        var expectedFormat = session.Configuration.Route.EvidenceKind == "windows-process-tree-loopback"
            ? CaptureFormat.ProcessLoopback : session.Configuration.Capture.MixFormat;
        if (bound != null || running || device.Format != expectedFormat)
            throw new CaptureFailure("CAPTURE_STATE_INVALID");
        bound = session;
        session.MarkPrepared();
    }, "initialize");

    internal void Start(CaptureSession session) => Invoke(device =>
    {
        RequireBound(session);
        if (running) return;
        session.RequireStartable();
        device.Start(); running = true;
        session.MarkRunning();
    });

    // A new unpublished generation gets its cut before the first device Start.
    internal CapturePositionEpochEvidence StartPositionEpoch(CaptureSession session, string intent)
    {
        CapturePositionEpochEvidence? evidence = null;
        Invoke(device =>
        {
            RequireBound(session);
            if (running) throw new CaptureFailure("CAPTURE_STATE_INVALID");
            session.RequireFreshPositionEpoch();
            device.Reset(); device.ClearScratch();
            evidence = new(session.Lease.Session, session.Lease.Generation, intent, ++resetSequence,
                0, 0, 0, false, true, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            session.ObserveFreshPositionEpoch(evidence);
            device.Start(); running = true; session.MarkRunning();
        });
        return evidence ?? throw new CaptureFailure("CAPTURE_POSITION_EPOCH_INVALID");
    }

    internal CaptureResetBoundary Park(CaptureSession session)
    {
        Invoke(device =>
        {
            RequireBound(session);
            if (!running) throw new CaptureFailure("CAPTURE_STATE_INVALID");
            session.RequirePlayingSeek();
            // First retire publication; the old pipe can only ever carry old bytes.
            session.CloseGeneration();
            StopAndReset(device);
            LastReset = new(session.Lease.Session, session.Lease.Generation, ++resetSequence,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            bound = null;
        }, "stop");
        return LastReset ?? throw new CaptureFailure("CAPTURE_STATE_INVALID");
    }

    internal CapturePositionEpochEvidence BeginPositionEpoch(CaptureSession session, string intent)
    {
        CapturePositionEpochEvidence? evidence = null;
        Invoke(device =>
        {
            RequireBound(session); session.RequirePositionEpoch();
            if (!running) throw new CaptureFailure("CAPTURE_STATE_INVALID");
            StopAndReset(device);
            session.CutUnpublishedBootstrap();
            evidence = new(session.Lease.Session, session.Lease.Generation, intent, ++resetSequence,
                0, 0, 0, false, true, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            session.ObservePositionEpoch(evidence);
            device.Start(); running = true;
            // Lifecycle remains this unpublished generation. Its gate is sealed
            // again until CaptureEngine's fresh post-restart inspection succeeds.
        }, "stop");
        return evidence ?? throw new CaptureFailure("CAPTURE_POSITION_EPOCH_INVALID");
    }

    private void RequireBound(CaptureSession session)
    {
        if (!ReferenceEquals(bound, session)) throw new CaptureFailure("STALE_GENERATION");
    }

    private void Invoke(Action<ICaptureDevice> action, string stage = "start")
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (failure != null) throw new CaptureFailure(failure.Code, failure.Hresult);
            if (Volatile.Read(ref closing) != 0) throw new CaptureFailure("CAPTURE_CLOSED");
            commands.Enqueue(new(action, completion, stage)); commandReady.Set();
        }
        try { completion.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
        catch (TimeoutException) { Dispose(); throw new CaptureFailure("CAPTURE_START_TIMEOUT"); }
    }

    private void StopAndReset(ICaptureDevice device)
    {
        try
        {
            if (running) { device.Stop(); running = false; }
            // Reset is never called until Stop has returned successfully.
            device.Reset();
        }
        finally { device.ClearScratch(); }
    }

    private void Remember(Exception error, string stage)
    {
        CaptureFailureDiagnostic diagnostic;
        lock (gate)
        {
            diagnostic = failure ??= CaptureFailureDiagnostic.From(error, stage);
            if (stage == "stop") cleanupFailure ??= CaptureFailureDiagnostic.From(error, stage);
        }
        // Native/device failures belong to this owner, so they revoke whichever
        // generation is bound now. A generation-specific pipe failure does not.
        bound?.Fail(diagnostic);
    }

    private void Run(Func<ICaptureDevice> createDevice)
    {
        ICaptureDevice? device = null;
        var stage = "initialize";
        try
        {
            device = createDevice(); Format = device.Format;
            initialized.TrySetResult(true);
            while (Volatile.Read(ref closing) == 0)
            {
                while (commands.TryDequeue(out var work))
                {
                    try
                    {
                        stage = work.Stage; work.Action(device); work.Completion.TrySetResult(true);
                    }
                    catch (Exception error)
                    {
                        Remember(error, stage); work.Completion.TrySetException(error); throw;
                    }
                }
                if (Volatile.Read(ref closing) != 0) break;
                if (!running || bound == null) { commandReady.WaitOne(); continue; }
                stage = "read";
                bound.CheckBootstrapDeadline();
                if (WaitHandle.WaitAny([commandReady, device.SamplesReady], 1000) == 0) continue;
                bound.CheckBootstrapDeadline();
                // Commands preempt further reads. An in-flight packet is released
                // before any Stop/Reset, Bind, or next-generation Start can execute.
                while (Volatile.Read(ref closing) == 0 && commands.IsEmpty && !bound.Terminal && device.ReadPacket(bound)) { }
                if (bound.Terminal) { Volatile.Write(ref closing, 1); break; }
            }
        }
        catch (Exception error) { Remember(error, stage); initialized.TrySetException(error); }
        finally
        {
            if (device != null)
            {
                try { if (running) StopAndReset(device); else device.ClearScratch(); }
                catch (Exception error) { Remember(error, "stop"); }
                try { device.Dispose(); }
                catch (Exception error) { Remember(error, "stop"); }
            }
            bound?.CloseGeneration();
            lock (gate)
            {
                Volatile.Write(ref closing, 1);
                while (commands.TryDequeue(out var pending))
                    pending.Completion.TrySetException(new CaptureFailure(failure?.Code ?? "CAPTURE_CLOSED", failure?.Hresult));
            }
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            Volatile.Write(ref closing, 1);
            if (!eventDisposed) commandReady.Set();
        }
        if (Thread.CurrentThread == thread) return;
        if (!thread.Join(2000)) throw new CaptureFailure("CAPTURE_STOP_TIMEOUT");
        lock (gate)
        {
            if (!eventDisposed) { commandReady.Dispose(); eventDisposed = true; }
            if (cleanupFailure is { } failed) throw new CaptureFailure(failed.Code, failed.Hresult);
        }
    }
}
