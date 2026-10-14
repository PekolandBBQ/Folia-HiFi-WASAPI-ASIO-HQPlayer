namespace Folia.Capture;

internal interface ISilentRenderFormatEndpoint : ITemporaryFormatEndpoint
{
    void MaintainSilence();
}

// All render COM work stays on one owner thread. The control STA exchanges only
// requests and immutable format descriptors; its 40 ms loop cannot starve rendering.
internal sealed class ActiveRenderFormatLease : ITemporaryFormatEndpoint
{
    private readonly object controlGate = new();
    private readonly AutoResetEvent bufferReady = new(false), readRequested = new(false);
    private readonly ManualResetEvent stopping = new(false);
    private readonly TaskCompletionSource<bool> initialized = NewCompletion<bool>(), exited = NewCompletion<bool>();
    private TaskCompletionSource<CaptureFormat>? pendingRead;
    private CaptureFailure? failure, cleanupFailure, timeoutFailure;
    private bool disposed;
    private readonly TimeSpan operationTimeout;

    private static TaskCompletionSource<T> NewCompletion<T>() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private ActiveRenderFormatLease(Func<EventWaitHandle, ISilentRenderFormatEndpoint> acquire, Action<Thread>? configureThread,
        TimeSpan operationTimeout)
    {
        this.operationTimeout = operationTimeout;
        var owner = new Thread(() => Run(acquire)) { IsBackground = true, Name = "Folia silent format lease" };
        try { configureThread?.Invoke(owner); owner.Start(); }
        catch { bufferReady.Dispose(); readRequested.Dispose(); stopping.Dispose(); throw; }
    }

    internal static ActiveRenderFormatLease Acquire(Func<EventWaitHandle, ISilentRenderFormatEndpoint> acquire,
        Action<Thread>? configureThread = null, TimeSpan? operationTimeout = null)
    {
        var lease = new ActiveRenderFormatLease(acquire, configureThread, operationTimeout ?? TimeSpan.FromSeconds(2));
        try { lease.Await(lease.initialized.Task); return lease; }
        catch (Exception error) { throw FormatLeasePolicy.CleanupFailure(error, lease.Dispose); }
    }

    private T Await<T>(Task<T> task)
    {
        try { return task.WaitAsync(operationTimeout).GetAwaiter().GetResult(); }
        catch (TimeoutException)
        {
            timeoutFailure ??= FormatLeasePolicy.UnconfirmedCleanup(new CaptureFailure("FORMAT_LEASE_FAILED"));
            throw timeoutFailure;
        }
    }

    public CaptureFormat ReadCurrent()
    {
        lock (controlGate)
        {
            if (disposed) throw new CaptureFailure("FORMAT_LEASE_CLOSED");
            if (Volatile.Read(ref failure) is { } failed) throw failed;
            var response = NewCompletion<CaptureFormat>();
            Volatile.Write(ref pendingRead, response); readRequested.Set();
            // A worker failure between the first check and request publication must
            // also settle this read, rather than masquerading as a timeout.
            if (Volatile.Read(ref failure) is { } raced) response.TrySetException(raced);
            try { return Await(response.Task); }
            catch { stopping.Set(); throw; }
        }
    }

    private void Run(Func<EventWaitHandle, ISilentRenderFormatEndpoint> acquire)
    {
        ISilentRenderFormatEndpoint? endpoint = null;
        Exception? original = null;
        try
        {
            endpoint = acquire(bufferReady);
            if (stopping.WaitOne(0)) throw new CaptureFailure("FORMAT_LEASE_CLOSED");
            initialized.TrySetResult(true);
            WaitHandle[] waits = [stopping, readRequested, bufferReady];
            while (true)
            {
                var signaled = WaitHandle.WaitAny(waits);
                if (signaled == 0) break;
                if (signaled == 1)
                    Volatile.Read(ref pendingRead)?.TrySetResult(endpoint.ReadCurrent());
                else endpoint.MaintainSilence();
            }
        }
        catch (Exception error) { original = error; }
        finally
        {
            try { endpoint?.Dispose(); }
            catch (Exception error) { cleanupFailure = FormatLeasePolicy.UnconfirmedCleanup(error); }
            if (original != null || cleanupFailure != null)
            {
                var failed = cleanupFailure == null ? FormatLeasePolicy.CleanupFailure(original!)
                    : FormatLeasePolicy.UnconfirmedCleanup(original ?? cleanupFailure);
                Volatile.Write(ref failure, failed);
                initialized.TrySetException(failed);
                Volatile.Read(ref pendingRead)?.TrySetException(failed);
            }
            exited.TrySetResult(true);
        }
    }

    public void Dispose()
    {
        lock (controlGate)
        {
            if (disposed) return;
            stopping.Set();
            // Timeout leaves handles/COM with their owner. The existing engine
            // poisons the helper; another thread must never release those objects.
            Await(exited.Task);
            disposed = true;
            bufferReady.Dispose(); readRequested.Dispose(); stopping.Dispose();
            if (cleanupFailure != null) throw cleanupFailure;
            // A later owner exit cannot erase the earlier unconfirmed interval.
            if (timeoutFailure != null) throw timeoutFailure;
        }
    }
}
