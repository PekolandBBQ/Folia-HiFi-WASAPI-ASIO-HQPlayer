namespace Folia.Capture;

public sealed record SpotifyProcessLease(int ProcessId, long StartedAtUnixMs, string ExecutablePath, string? StartedAtUtcTicks = null)
{
    public static SpotifyProcessLease Bind(IReadOnlyList<RenderSessionEvidence> sessions, int? expectedPid = null, long? expectedStart = null)
    {
        if (expectedPid.HasValue != expectedStart.HasValue || expectedPid <= 0 || expectedStart <= 0)
            throw new CaptureFailure("INVALID_REQUEST");
        var candidates = sessions.Where(item => item.State != "expired" && RoutePolicy.IsSpotify(item))
            .Select(item => new SpotifyProcessLease(item.ProcessId, item.StartedAtUnixMs, item.ExecutablePath!, item.StartedAtUtcTicks)).Distinct().ToArray();
        if (candidates.Length == 0) throw new CaptureFailure("SPOTIFY_ROUTE_NOT_FOUND");
        if (candidates.Length != 1) throw new CaptureFailure("SPOTIFY_PROCESS_AMBIGUOUS");
        var identity = candidates[0];
        if (identity.StartedAtUnixMs <= 0) throw new CaptureFailure("ROUTE_IDENTITY_UNAVAILABLE");
        if (expectedPid.HasValue && (identity.ProcessId != expectedPid || identity.StartedAtUnixMs != expectedStart))
            throw new CaptureFailure("SPOTIFY_PROCESS_CHANGED");
        return identity;
    }

    public void RequireUnchanged(IReadOnlyList<RenderSessionEvidence> sessions)
    {
        var actual = Bind(sessions);
        if (actual.ProcessId != ProcessId || actual.StartedAtUnixMs != StartedAtUnixMs
            || !actual.ExecutablePath.Equals(ExecutablePath, StringComparison.OrdinalIgnoreCase)
            || (StartedAtUtcTicks != null && actual.StartedAtUtcTicks != StartedAtUtcTicks))
            throw new CaptureFailure("SPOTIFY_PROCESS_CHANGED");
    }

    public static SpotifyProcessLease BindBootstrap(RenderSessionEvidence actual, int pid, long startedMs, string ticks)
    {
        if (pid <= 0 || startedMs <= 0 || ticks.Length is < 1 or > 19 || ticks.Any(ch => ch is < '0' or > '9')
            || !long.TryParse(ticks, out var exactTicks) || exactTicks <= 0 || exactTicks > DateTime.MaxValue.Ticks
            || ticks != exactTicks.ToString(System.Globalization.CultureInfo.InvariantCulture))
            throw new CaptureFailure("INVALID_REQUEST");
        if (!RoutePolicy.IsSpotify(actual) || actual.IsSystemSounds || actual.State != "running"
            || actual.ProcessId != pid || actual.StartedAtUnixMs != startedMs || actual.StartedAtUtcTicks != ticks)
            throw new CaptureFailure("SPOTIFY_PROCESS_CHANGED");
        return new(pid, startedMs, actual.ExecutablePath!, ticks);
    }

    public void RequireBootstrapProcess(RenderSessionEvidence actual)
    {
        var next = BindBootstrap(actual, ProcessId, StartedAtUnixMs,
            StartedAtUtcTicks ?? throw new CaptureFailure("SPOTIFY_PROCESS_CHANGED"));
        if (!next.ExecutablePath.Equals(ExecutablePath, StringComparison.OrdinalIgnoreCase))
            throw new CaptureFailure("SPOTIFY_PROCESS_CHANGED");
    }
}
