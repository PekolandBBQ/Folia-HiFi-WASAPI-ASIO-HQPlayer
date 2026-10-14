namespace Folia.Capture;

public sealed class CaptureFailure(string code, int? nativeHResult = null) : Exception(code)
{
    public string Code { get; } = code;
    public int? NativeHResult { get; } = nativeHResult;
    public bool CleanupFailed { get; internal set; }
    public FormatLeaseReadbackEvidence? FormatLeaseReadback { get; internal set; }
}
