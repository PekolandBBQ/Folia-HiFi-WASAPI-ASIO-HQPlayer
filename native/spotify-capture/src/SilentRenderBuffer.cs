namespace Folia.Capture;

internal interface ISilentRenderClient
{
    uint BufferFrames();
    uint PaddingFrames();
    void AcquireBuffer(uint frames);
    void ReleaseSilentBuffer(uint frames);
    void Start();
    void Stop();
}

// Shared with focused device-free tests. No PCM is accepted or written by this
// path: every acquired packet is released with AUDCLNT_BUFFERFLAGS_SILENT.
internal sealed class SilentRenderBuffer(ISilentRenderClient client)
{
    private uint capacity;
    private bool started, startAttempted;

    internal void Start()
    {
        capacity = client.BufferFrames();
        if (capacity == 0) throw new CaptureFailure("FORMAT_LEASE_FAILED");
        Fill();
        startAttempted = true;
        client.Start(); started = true;
    }

    internal void Fill()
    {
        var padding = client.PaddingFrames();
        if (padding > capacity) throw new CaptureFailure("FORMAT_LEASE_FAILED");
        var available = capacity - padding;
        if (available == 0) return;
        client.AcquireBuffer(available);
        client.ReleaseSilentBuffer(available);
    }

    internal void Maintain()
    {
        if (!started) throw new CaptureFailure("FORMAT_LEASE_CLOSED");
        Fill();
    }

    internal void Stop()
    {
        if (!startAttempted) return;
        startAttempted = started = false;
        client.Stop();
    }
}
