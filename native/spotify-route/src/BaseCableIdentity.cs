namespace Folia.Capture;

// Observed Windows device association, not driver-signature or sample-provenance attestation.
public sealed record BaseCableIdentityEvidence(string State, string? OwnerInstanceId = null,
    string? FailureStage = null, uint? ConfigRet = null, int? Hresult = null);

public static class BaseCableIdentity
{
    public const string HardwareId = "VBAudioVACWDM";
    public const string Service = "VBAudioVACMME";
    public static readonly Guid MediaClass = new("4d36e96c-e325-11ce-bfc1-08002be10318");

    public static bool Supported(string flow, BaseCableIdentityEvidence identity) =>
        flow is "render" or "capture" && identity.State == "verified"
        && !string.IsNullOrWhiteSpace(identity.OwnerInstanceId);

    public static bool SameOwner(BaseCableIdentityEvidence? capture, BaseCableIdentityEvidence? render) =>
        capture is { State: "verified" } && render is { State: "verified" }
        && !string.IsNullOrWhiteSpace(capture.OwnerInstanceId)
        && string.Equals(capture.OwnerInstanceId, render.OwnerInstanceId, StringComparison.OrdinalIgnoreCase);
}
