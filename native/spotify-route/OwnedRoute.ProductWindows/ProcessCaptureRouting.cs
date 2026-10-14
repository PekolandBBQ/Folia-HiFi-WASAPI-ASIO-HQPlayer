namespace Folia.RouteRunner;

// The r2 host enables this only alongside a capture helper advertising native
// process-tree capture. Endpoint-mix isolation is still used by legacy hosts.
internal static class ProcessCaptureRouting
{
    internal static bool Enabled => Environment.GetEnvironmentVariable("FOLIA_SPOTIFY_PROCESS_CAPTURE") == "1";
}
