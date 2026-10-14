namespace Folia.Capture;

public interface ITemporaryFormatEndpoint : IDisposable
{
    CaptureFormat ReadCurrent();
}

public sealed record TemporaryFormatSnapshot(CaptureFormat Capture, CaptureFormat Render,
    bool Verified = true, string Mode = "shared-engine-match-format", bool PersistentSettingsChanged = false);

// Factories own partial construction cleanup. This owner releases both endpoints if either
// acquisition or readback fails, and never reports success from only one changed endpoint.
public sealed class TemporaryFormatPair : IDisposable
{
    private readonly ITemporaryFormatEndpoint capture, render;
    private bool disposed;
    private TemporaryFormatPair(ITemporaryFormatEndpoint capture, ITemporaryFormatEndpoint render)
    { this.capture = capture; this.render = render; }

    public static TemporaryFormatPair Acquire(Func<ITemporaryFormatEndpoint> captureFactory, Func<ITemporaryFormatEndpoint> renderFactory)
    {
        ITemporaryFormatEndpoint? capture = null, render = null;
        try
        {
            capture = captureFactory(); render = renderFactory();
            var pair = new TemporaryFormatPair(capture, render);
            pair.ReadCurrent(); return pair;
        }
        catch (Exception error)
        { throw FormatLeasePolicy.CleanupFailure(error, () => render?.Dispose(), () => capture?.Dispose()); }
    }

    public TemporaryFormatSnapshot ReadCurrent()
    {
        if (disposed) throw new CaptureFailure("FORMAT_LEASE_CLOSED");
        var input = capture.ReadCurrent(); var output = render.ReadCurrent();
        if (input.SampleRate != 44100 || input.Channels != 2 || output.SampleRate != 44100 || output.Channels != 2)
            throw new CaptureFailure("FORMAT_LEASE_READBACK_MISMATCH");
        input.RequireSupported(); output.RequireSupported();
        return new(input, output);
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        try { render.Dispose(); } finally { capture.Dispose(); }
    }
}
