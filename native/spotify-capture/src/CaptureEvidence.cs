using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Folia.Capture;

// Immutable wire evidence shared by native inspection and device-free orchestration tests.
internal sealed record EndpointEvidence(string Id, string Name, string DeviceName, string Flow,
    string InstanceId, CaptureFormat MixFormat, bool SupportedBaseCable,
    CaptureFormat? ConfiguredMixFormat = null, string MixFormatKind = "get-mix-format",
    BaseCableIdentityEvidence? BaseIdentity = null, uint? FormFactor = null);
internal sealed record DefaultEndpointEvidence(string Flow, string Role, bool Available,
    string? Id, string? Name, string? DeviceName, int? Hresult = null);

internal sealed record ConfigurationEvidence(bool Ready, string[] Issues, EndpointEvidence Capture,
    EndpointEvidence Render, RouteDecision Route, RenderSessionEvidence[] Sessions, DefaultEndpointEvidence[] DefaultEndpoints,
    int SelectedSampleRate = 44100, int SelectedChannels = 2, string PreparedFormat = "s32le",
    bool SampleRateConversion = false, bool TemporaryFormatLeaseEligible = false, FormatLeaseEvidence? FormatLease = null,
    bool BootstrapReady = false);

internal sealed record EndpointFormatPair(CaptureFormat Capture, CaptureFormat Render);
internal sealed record FormatLeaseEvidence(bool Requested, string State, bool Verified,
    EndpointFormatPair Before, EndpointFormatPair After,
    bool PersistentSettingsChanged = false, bool ExactRestorationPromised = false);

// Native-to-main IPC only. Not included in configuration, status or terminal data.
internal sealed record OwnedSilentRenderLeaseEvidence(string CaptureSession, long CaptureGeneration,
    string EndpointId, string SessionInstanceId, Guid GroupingId, int ProcessId, string StartedAtUtcTicks);

internal static class CaptureOpenEvidence
{
    internal static object WithSilentRenderLease(object snapshot, OwnedSilentRenderLeaseEvidence? proof)
    {
        if (proof == null) return snapshot;
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var result = JsonSerializer.SerializeToElement(snapshot, options).EnumerateObject()
            .ToDictionary(item => item.Name, item => item.Value);
        result.Add("ownedSilentRenderLease", JsonSerializer.SerializeToElement(proof, options));
        return result;
    }
}

// Terminal counters are sampled from this generation after cleanup is attempted.
// Failed cleanup is explicit; this receipt never proves playback or route readiness.
internal sealed record CaptureTerminalEvidence(string Session, long Generation, string State, string? ErrorCode,
    long CapturedFrames, long DeliveredFrames, int QueuedBytes, string? BootstrapMode, string? BootstrapDelivery,
    string DeliveryState, bool CleanupConfirmed, string SnapshotSource = "native-terminal",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Hresult = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? FailureStage = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] FormatLeaseReadbackEvidence? FormatLeaseReadback = null,
    long ConcealedFrames = 0, long Discontinuities = 0, long LastGapFrames = 0);

// Retain only an existing native result and a closed execution-stage label.
// Managed exception HRESULTs and arbitrary exception text are not native evidence.
internal sealed record CaptureFailureDiagnostic(string Code, int? Hresult, string? FailureStage,
    FormatLeaseReadbackEvidence? FormatLeaseReadback = null)
{
    internal static CaptureFailureDiagnostic From(Exception error, string stage) =>
        For(error is CaptureFailure failure ? failure.Code : "CAPTURE_DEVICE_FAILED", error, stage);
    internal static CaptureFailureDiagnostic For(string code, Exception? error, string? stage) =>
        new(code, error is CaptureFailure failure ? failure.NativeHResult : error is COMException ? error.HResult : null,
            stage is "initialize" or "start" or "read" or "stop" or "pipe" ? stage : null,
            code == "FORMAT_LEASE_READBACK_MISMATCH" && error is CaptureFailure readback ? readback.FormatLeaseReadback : null);
}


internal sealed record CaptureResetBoundary(string PreviousSession, long PreviousGeneration,
    long ResetSequence, long StoppedAndResetAtUnixMs);


internal sealed record CapturePositionEpochEvidence(string Session, long Generation, string PositionIntentId,
    long CutSequence, long CapturedFramesAtCut, long DeliveredFramesAtCut, int QueuedBytesAtCut,
    bool StartValidated, bool FreshBuffer, long StoppedAndResetAtUnixMs);
