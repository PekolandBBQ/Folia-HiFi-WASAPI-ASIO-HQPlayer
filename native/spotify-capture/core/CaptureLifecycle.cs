namespace Folia.Capture;

public sealed record CaptureLifecycleState(string State, string? ErrorCode, bool Terminal);

// All readiness publications and terminal transitions share one lock. A late COM success
// can never resurrect a failed/closed generation or acknowledge a usable capture stream.
public sealed class CaptureLifecycle
{
    private readonly object gate = new();
    private readonly TaskCompletionSource<bool> prepared = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> running = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private string state = "opening";
    private string? error;
    private bool terminal;
    public Task Prepared => prepared.Task;
    public Task Running => running.Task;
    public CaptureLifecycleState Snapshot { get { lock (gate) return new(state, error, terminal); } }

    public bool MarkPrepared()
    {
        lock (gate)
        {
            if (terminal) return false;
            if (state != "opening") throw new CaptureFailure("CAPTURE_STATE_INVALID");
            state = "prepared"; prepared.TrySetResult(true); return true;
        }
    }

    public bool RequestStart()
    {
        lock (gate)
        {
            if (terminal) throw new CaptureFailure(error ?? "CAPTURE_CLOSED");
            if (state == "running" || state == "starting") return false;
            if (state != "prepared") throw new CaptureFailure("CAPTURE_STATE_INVALID");
            state = "starting"; return true;
        }
    }

    public bool MarkRunning()
    {
        lock (gate)
        {
            if (terminal) return false;
            if (state != "starting") throw new CaptureFailure("CAPTURE_STATE_INVALID");
            state = "running"; running.TrySetResult(true); return true;
        }
    }

    public bool Fail(string code)
    {
        lock (gate)
        {
            if (terminal) return false;
            terminal = true; error = code; state = "failed";
            prepared.TrySetException(new CaptureFailure(code)); running.TrySetException(new CaptureFailure(code));
            return true;
        }
    }

    public void Close()
    {
        lock (gate)
        {
            if (terminal) return;
            terminal = true; state = "closed";
            prepared.TrySetException(new CaptureFailure("CAPTURE_CLOSED"));
            running.TrySetException(new CaptureFailure("CAPTURE_CLOSED"));
        }
    }
}
