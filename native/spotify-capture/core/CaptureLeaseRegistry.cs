namespace Folia.Capture;

// One control-thread owner. Reservation occurs only after configuration validation.
public sealed class CaptureLeaseRegistry
{
    private long highestGeneration;
    private readonly HashSet<string> usedPipes = new(StringComparer.Ordinal);

    public void ValidateNext(CaptureLease lease)
    {
        CaptureLease.Validate(lease.Session, lease.Generation, lease.PipeName);
        if (lease.Generation <= highestGeneration || usedPipes.Contains(lease.PipeName))
            throw new CaptureFailure("STALE_GENERATION");
        if (usedPipes.Count >= 65536) throw new CaptureFailure("HELPER_RESTART_REQUIRED");
    }

    public void Reserve(CaptureLease lease)
    {
        ValidateNext(lease);
        highestGeneration = lease.Generation; usedPipes.Add(lease.PipeName);
    }
}
