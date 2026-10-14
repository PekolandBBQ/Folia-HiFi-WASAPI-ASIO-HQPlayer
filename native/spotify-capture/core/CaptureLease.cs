using System.Text.RegularExpressions;

namespace Folia.Capture;

public sealed record CaptureLease(string Session, long Generation, string PipeName)
{
    public static void Validate(string session, long generation, string pipeName)
    {
        if (!Guid.TryParseExact(session, "D", out _) || generation is <= 0 or > 9007199254740991
            || !Regex.IsMatch(pipeName, "^folia-capture-[a-f0-9]{32}$", RegexOptions.CultureInvariant))
            throw new CaptureFailure("INVALID_REQUEST");
    }

    public void RequireOwner(string session, long generation)
    {
        if (session != Session || generation != Generation) throw new CaptureFailure("STALE_GENERATION");
    }
}
