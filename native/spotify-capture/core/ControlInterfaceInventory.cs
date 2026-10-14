namespace Folia.Capture;

// Bounded read-only evidence. An exposed interface does not establish successful vendor-panel I/O.
public sealed record ControlInterfaceEvidence(string State, int InterfaceCount, int ActiveInterfaceCount,
    int? Win32Error = null, string? FailureStage = null);
public readonly record struct ControlInterfaceStep(bool Found, uint Flags, int Win32Error);

public static class ControlInterfaceInventory
{
    public const int Limit = 64;
    public const int NoMoreItems = 259;

    // The native adapter owns and releases its SetupAPI handle; this core never opens a device.
    public static ControlInterfaceEvidence Read(Func<uint, ControlInterfaceStep> next)
    {
        var count = 0; var active = 0;
        for (uint index = 0; index <= Limit; index++)
        {
            var step = next(index);
            if (!step.Found)
                return new(step.Win32Error == NoMoreItems ? "complete" : "failed", count, active,
                    step.Win32Error == NoMoreItems ? null : step.Win32Error,
                    step.Win32Error == NoMoreItems ? null : "enumerate");
            if (index == Limit) return new("limit", count, active);
            count++;
            if ((step.Flags & 1) != 0 && (step.Flags & 4) == 0) active++;
        }
        throw new InvalidOperationException();
    }
}
