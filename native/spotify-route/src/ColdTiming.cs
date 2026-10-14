using System.Diagnostics;
namespace Folia.RouteRunner;
// Optional local cold-start timing; no source identities or PCM are recorded.
internal sealed class ColdTiming : IDisposable
{
    private readonly string stage;
    private readonly long start=Stopwatch.GetTimestamp();
    private ColdTiming(string value) { stage=value; }
    internal static ColdTiming Scope(string stage) => new(stage);
    public void Dispose()
    {
        var path=Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
        if(string.IsNullOrWhiteSpace(path))return;
        try { File.AppendAllText(path, System.Text.Json.JsonSerializer.Serialize(new { at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), pid=Environment.ProcessId, stage, ms=Stopwatch.GetElapsedTime(start).TotalMilliseconds })+Environment.NewLine); } catch { }
    }
}