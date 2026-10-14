using System.Text.Json;

namespace Folia.RouteRunner;

// Keep native recovery failure identifiers without writing source tokens, URIs or account data.
internal static class RouteRecoveryDiagnostic
{
    internal static void Record(string stage, Exception error)
    {
        var path = Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
        if (string.IsNullOrWhiteSpace(path)) return;
        var code = error.Message.Split(':', 2)[0];
        if (code.Length is < 1 or > 128 || code.Any(c => !(c is >= 'A' and <= 'Z' or >= '0' and <= '9' or '_')))
            code = error.GetType().Name;
        try { File.AppendAllText(path, JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            pid = Environment.ProcessId, stage, code }) + Environment.NewLine); } catch { }
    }
}
