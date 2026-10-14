namespace Folia.Capture;

public sealed record RenderSessionEvidence(int ProcessId, string State, string? ProcessName,
    string? ExecutablePath, bool IsSystemSounds, bool IdentityReadable, long StartedAtUnixMs = 0, bool IsOwnedFormatLease = false,
    string? StartedAtUtcTicks = null, bool IsOwnedActiveSilentFormatLease = false);

public sealed record RouteDecision(bool Ready, string[] Issues, bool SpotifySessionPresent,
    bool SpotifyOnlyObserved, string EvidenceKind = "windows-render-session-process-snapshot");

public static class RoutePolicy
{
    public static bool IsSpotify(RenderSessionEvidence session) => session.IdentityReadable && session.ProcessId > 0
        && string.Equals(session.ProcessName, "Spotify", StringComparison.OrdinalIgnoreCase)
        && string.Equals(Path.GetFileName(session.ExecutablePath?.Replace('\\', '/')), "Spotify.exe", StringComparison.OrdinalIgnoreCase);

    public static RouteDecision Evaluate(IReadOnlyList<RenderSessionEvidence> sessions,
        bool cableIsDefaultRender, bool outputIsCable, bool processCapture = false)
    {
        var issues = new HashSet<string>();
        if (cableIsDefaultRender && !processCapture) issues.Add("CABLE_IS_DEFAULT_RENDER");
        if (outputIsCable) issues.Add("FOLIA_FEEDBACK_ROUTE");
        var spotify = false;
        foreach (var session in sessions.Where(item => item.State != "expired"))
        {
            if (session.IsOwnedFormatLease && (session.State == "inactive"
                || (session.State == "active" && session.IsOwnedActiveSilentFormatLease))
                && session.IdentityReadable && !session.IsSystemSounds) continue;
            var name = session.ProcessName ?? "";
            var spotifyProcess = IsSpotify(session);
            spotify |= spotifyProcess;
            if (!processCapture && session.IdentityReadable && (name.Contains("folia", StringComparison.OrdinalIgnoreCase)
                || name.Contains("hqplayer", StringComparison.OrdinalIgnoreCase))) issues.Add("FOLIA_FEEDBACK_ROUTE");
            if (!processCapture && session.State == "active" && (!spotifyProcess || session.IsSystemSounds))
                issues.Add(session.IdentityReadable || session.IsSystemSounds ? "CABLE_SHARED_WITH_OTHER_AUDIO" : "ROUTE_IDENTITY_UNAVAILABLE");
        }
        if (!spotify) issues.Add("SPOTIFY_ROUTE_NOT_FOUND");
        if (sessions.Where(item => item.State != "expired" && IsSpotify(item)).Select(item => item.ProcessId).Distinct().Count() > 1)
            issues.Add("SPOTIFY_PROCESS_AMBIGUOUS");
        var ready = issues.Count == 0;
        return new(ready, issues.Order().ToArray(), spotify, ready,
            processCapture ? "windows-process-tree-loopback" : "windows-render-session-process-snapshot");
    }
}
