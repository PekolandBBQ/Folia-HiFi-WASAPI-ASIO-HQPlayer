using System.Globalization;
using System.Text.Json;
using Folia.RouteResearch;

namespace Folia.ProductRoute;

// An assertion from the owned capture child, carried only by main's native host.
// The Windows adapter must independently bind the live process and actual session.
public sealed record OwnedSilentRenderLeaseProof(string CaptureSession, long CaptureGeneration,
    string EndpointId, string SessionInstanceId, Guid GroupingId, int ProcessId, long StartedAtUtcTicks)
{
    public void RequireSeekRebind(OwnedSilentRenderLeaseProof next)
    {
        if (next.CaptureSession != CaptureSession || next.CaptureGeneration <= CaptureGeneration
            || next.EndpointId != EndpointId || next.SessionInstanceId != SessionInstanceId
            || next.GroupingId != GroupingId || next.ProcessId != ProcessId || next.StartedAtUtcTicks != StartedAtUtcTicks)
            throw new RouteBlockedException("SEEK_PARK_KEEPER_CHANGED");
    }

    public static OwnedSilentRenderLeaseProof? Read(JsonElement payload, string session, string renderEndpoint)
    {
        if (!payload.TryGetProperty("ownedSilentRenderLease", out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Object) throw Invalid();
        string[] keys = ["captureSession", "captureGeneration", "endpointId", "sessionInstanceId", "groupingId", "processId", "startedAtUtcTicks"];
        var fields = value.EnumerateObject().Select(item => item.Name).ToArray();
        if (fields.Length != keys.Length || fields.Distinct(StringComparer.Ordinal).Count() != keys.Length || fields.Except(keys).Any()) throw Invalid();
        string Text(string key, int maximum) => value.GetProperty(key).ValueKind == JsonValueKind.String && value.GetProperty(key).GetString() is { } text &&
            !string.IsNullOrWhiteSpace(text) && text.Length <= maximum && !text.Any(char.IsControl) ? text : throw Invalid();
        var captureSession = Text("captureSession", 128);
        var endpoint = Text("endpointId", 512);
        if (captureSession != session || endpoint != renderEndpoint ||
            !value.GetProperty("captureGeneration").TryGetInt64(out var generation) || generation < 1 || generation > 9007199254740991 ||
            !value.GetProperty("processId").TryGetInt32(out var pid) || pid <= 0 ||
            !Guid.TryParseExact(Text("groupingId", 36), "D", out var group) || group == Guid.Empty ||
            !long.TryParse(Text("startedAtUtcTicks", 19), NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) || ticks <= 0)
            throw Invalid();
        return new(captureSession, generation, endpoint, Text("sessionInstanceId", 4096), group, pid, ticks);
    }
    private static RouteBlockedException Invalid() => new("OWNED_SILENT_RENDER_LEASE_INVALID");
}
