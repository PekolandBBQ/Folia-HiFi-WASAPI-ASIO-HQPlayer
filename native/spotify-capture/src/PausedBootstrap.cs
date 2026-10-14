namespace Folia.Capture;

// Private capture eligibility, never proof that the source is paused or fully routed.
// The product route service must independently qualify and own the paused source.
internal static class PausedBootstrap
{
    internal static ConfigurationEvidence Require(ConfigurationEvidence configuration, SpotifyProcessLease spotify,
        RenderSessionEvidence process, bool allowRateMismatch = false)
    {
        spotify.RequireBootstrapProcess(process);
        if (!configuration.Capture.SupportedBaseCable || !configuration.Render.SupportedBaseCable
            || configuration.Capture.Flow != "capture" || configuration.Render.Flow != "render"
            || !BaseCableIdentity.SameOwner(configuration.Capture.BaseIdentity, configuration.Render.BaseIdentity))
            throw new CaptureFailure("BASE_CABLE_ENDPOINT_REQUIRED");
        foreach (var issue in configuration.Issues.Concat(configuration.Route.Issues).Distinct())
            if (issue != "SPOTIFY_ROUTE_NOT_FOUND"
                && !(allowRateMismatch && issue is "CAPTURE_RATE_MISMATCH" or "RENDER_RATE_MISMATCH"))
                throw new CaptureFailure(issue);
        // A readable but different Spotify session is not this lease's source.
        if (configuration.Sessions.Any(item => item.State != "expired" && RoutePolicy.IsSpotify(item)))
            spotify.RequireUnchanged(configuration.Sessions);
        // Re-evaluate active writers independently of readiness summaries.
        var route = RoutePolicy.Evaluate(configuration.Sessions, false, false,
            processCapture: configuration.Route.EvidenceKind == "windows-process-tree-loopback");
        if (route.Issues.Any(issue => issue != "SPOTIFY_ROUTE_NOT_FOUND"))
            throw new CaptureFailure(route.Issues.First(issue => issue != "SPOTIFY_ROUTE_NOT_FOUND"));
        if (route.EvidenceKind == "windows-process-tree-loopback")
            return configuration with { BootstrapReady = true };
        var captureIssue = configuration.Capture.MixFormat.ConfigurationIssue();
        if (captureIssue != null && !(allowRateMismatch && captureIssue == "CAPTURE_RATE_MISMATCH"))
            throw new CaptureFailure(captureIssue);
        if (configuration.Render.MixFormat.Channels != 2) throw new CaptureFailure("RENDER_CHANNELS_MISMATCH");
        if (!allowRateMismatch && configuration.Render.MixFormat.SampleRate != 44100)
            throw new CaptureFailure("RENDER_RATE_MISMATCH");
        return configuration with { BootstrapReady = captureIssue == null && configuration.Render.MixFormat.SampleRate == 44100 };
    }
}
