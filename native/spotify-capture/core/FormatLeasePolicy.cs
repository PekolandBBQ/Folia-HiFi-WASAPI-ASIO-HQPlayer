namespace Folia.Capture;

// Pure checks shared by the Windows lease implementation and device-free tests. They
// reject fallback/resampling and malformed engine evidence before publishing a lease.
public static class FormatLeasePolicy
{
    public static CaptureFormat Request(CaptureFormat previous)
    {
        var requested = previous with
        {
            SampleRate = CaptureFormat.SelectedRate,
            AverageBytesPerSecond = checked(CaptureFormat.SelectedRate * previous.BlockAlign)
        };
        requested.RequireSupported();
        return requested;
    }

    // Keep the acquisition/readback failure while attempting every cleanup in owner order.
    // A failed cleanup is separately attested so the control owner cannot reuse the helper.
    public static CaptureFailure CleanupFailure(Exception original, params Action[] releases)
    {
        var failure = original as CaptureFailure ?? new CaptureFailure("FORMAT_LEASE_FAILED",
            original is System.Runtime.InteropServices.COMException ? original.HResult : null);
        foreach (var release in releases)
        {
            try { release(); }
            catch { failure.CleanupFailed = true; }
        }
        return failure;
    }

    public static CaptureFailure UnconfirmedCleanup(Exception original)
    {
        var failure = CleanupFailure(original); failure.CleanupFailed = true; return failure;
    }

    public static void RequirePeriod(uint period, uint fundamental, uint minimum, uint maximum)
    {
        if (period == 0 || fundamental == 0 || minimum == 0 || maximum < minimum
            || period < minimum || period > maximum || period % fundamental != 0)
            throw new CaptureFailure("FORMAT_LEASE_PERIOD_INVALID");
    }

    public static CaptureFormat RequireReadback(CaptureFormat format, uint period, CaptureFormat? requested = null,
        string? endpointRole = null)
    {
        if (period == 0) throw new CaptureFailure("FORMAT_LEASE_READBACK_FAILED");
        if (format.SampleRate != CaptureFormat.SelectedRate || format.Channels != CaptureFormat.SelectedChannels)
            throw ReadbackMismatch(format, period, requested, endpointRole, "rate-or-channels");
        format.RequireSupported();
        if (requested != null && format != requested) throw ReadbackMismatch(format, period, requested, endpointRole, "descriptor");
        return format;
    }

    private static CaptureFailure ReadbackMismatch(CaptureFormat format, uint period, CaptureFormat? requested,
        string? endpointRole, string comparison) => new("FORMAT_LEASE_READBACK_MISMATCH")
        { FormatLeaseReadback = FormatLeaseReadbackEvidence.Create(requested, format, period, endpointRole, comparison) };

    public static void CheckResult(int result, string fallbackCode = "FORMAT_LEASE_FAILED")
    {
        if (result == 0) return;
        var value = unchecked((uint)result);
        var code = value is 0x88890029 or 0x88890028 or 0x8889000a ? "FORMAT_LEASE_LOCKED"
            : value is 0x80004002 or 0x88890008 ? "FORMAT_LEASE_UNSUPPORTED"
            : value == 0x88890020 ? "FORMAT_LEASE_PERIOD_INVALID" : fallbackCode;
        throw new CaptureFailure(code, result);
    }
}
