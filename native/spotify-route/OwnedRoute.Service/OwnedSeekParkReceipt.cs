using System.Text.Json;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

// A stopped/reset capture receipt is distinct from ordinary fully released PCM evidence.
public sealed record SeekResetBoundary(string PreviousSession, long PreviousGeneration, long ResetSequence, long StoppedAndResetAtUnixMs);
public sealed record OwnedSeekParkReceipt(string State, string Session, long Generation, string SeekToken, string SeekTransaction,
    int ExpiresInMs, bool CaptureStopped, bool CaptureReset, bool OldGenerationRetired, bool RetainedInitialized,
    bool FormatLeaseReleased, SeekResetBoundary ResetBoundary)
{
    public static readonly TimeSpan MaximumAge = TimeSpan.FromSeconds(5);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static OwnedSeekParkReceipt Read(JsonElement value)
    {
        string[] keys = ["state","session","generation","seekToken","seekTransaction","expiresInMs","captureStopped","captureReset","oldGenerationRetired","retainedInitialized","formatLeaseReleased","resetBoundary"];
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != keys.Length || value.EnumerateObject().Any(x => !keys.Contains(x.Name)))
            throw new RouteBlockedException("SEEK_PARK_RECEIPT_INVALID");
        var reset = value.GetProperty("resetBoundary");
        string[] resetKeys = ["previousSession", "previousGeneration", "resetSequence", "stoppedAndResetAtUnixMs"];
        if (reset.ValueKind != JsonValueKind.Object || reset.EnumerateObject().Count() != resetKeys.Length || reset.EnumerateObject().Any(x => !resetKeys.Contains(x.Name)))
            throw new RouteBlockedException("SEEK_PARK_RECEIPT_INVALID");
        var result = JsonSerializer.Deserialize<OwnedSeekParkReceipt>(value.GetRawText(), Json) ?? throw new RouteBlockedException("SEEK_PARK_RECEIPT_INVALID");
        return result;
    }
    public void Validate(string session, long generation, string transaction, DateTimeOffset now)
    {
        if (State != "seek-parked" || Session != session || Generation != generation || Generation <= 0
            || SeekTransaction != transaction || !Guid.TryParseExact(SeekToken, "D", out _) || !Guid.TryParseExact(SeekTransaction, "D", out _)
            || ExpiresInMs != 5000 || !CaptureStopped || !CaptureReset || !OldGenerationRetired || !RetainedInitialized || FormatLeaseReleased
            || ResetBoundary is null || ResetBoundary.PreviousSession != session || ResetBoundary.PreviousGeneration != generation
            || ResetBoundary.ResetSequence is not (> 0 and <= 9007199254740991L) || ResetBoundary.StoppedAndResetAtUnixMs <= 0
            || ResetBoundary.StoppedAndResetAtUnixMs > now.ToUnixTimeMilliseconds())
            throw new RouteBlockedException("SEEK_PARK_RECEIPT_INVALID");
        if (now.ToUnixTimeMilliseconds() - ResetBoundary.StoppedAndResetAtUnixMs >= ExpiresInMs)
            throw new RouteBlockedException("SEEK_PARK_EXPIRED");
    }
}
